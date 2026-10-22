from __future__ import annotations

import hashlib
import logging
import math
import threading
import time
import types
import weakref
from collections import OrderedDict
from typing import Any, Callable, Dict, List, Optional, Tuple

import torch
from einops import rearrange

import comfy.model_management
import comfy.patcher_extension
import comfy.utils
from comfy.ldm.flux.math import apply_rope
from comfy.ldm.modules.attention import optimized_attention_masked


_CONFIG_KEY = "krea2_style_transfer"
_CATEGORY = "Krea2 Style Transfer"
_REFERENCE_LATENT_CACHE_MAX_BYTES = 128 * 1024 * 1024
_RF_CACHE_MAX_BYTES = 512 * 1024 * 1024
_RF_RUN_IDENTIFIER_KEYS = frozenset(
    {"uuids", "cond_or_uncond", "sigmas", "sample_sigmas", "callbacks"}
)


def _log_timing(event: str, **fields: Any) -> None:
    parts: List[str] = []
    for name, value in fields.items():
        if isinstance(value, bool):
            rendered = "true" if value else "false"
        elif isinstance(value, float):
            rendered = f"{value:.1f}"
        else:
            rendered = str(value)
        parts.append(f"{name}={rendered}")
    logging.info("[Krea2 风格参考] %s %s", event, " ".join(parts))


def _tensor_nbytes(value: Any) -> int:
    if value is None:
        return 0
    if hasattr(value, "numel") and hasattr(value, "element_size"):
        try:
            return int(value.numel()) * int(value.element_size())
        except Exception:
            return 0
    if isinstance(value, dict):
        return sum(_tensor_nbytes(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return sum(_tensor_nbytes(item) for item in value)
    return 0


def _guard_objects(objects: Any) -> Optional[Tuple[Tuple[int, Any], ...]]:
    guards: List[Tuple[int, Any]] = []
    for obj in objects:
        try:
            guards.append((id(obj), weakref.ref(obj)))
        except TypeError:
            return None
    return tuple(guards)


def _guards_alive(guards: Any) -> bool:
    for expected_id, reference in guards or ():
        target = reference()
        if target is None or id(target) != expected_id:
            return False
    return True


class BoundedTensorLRU:
    """Thread-safe CPU tensor cache with an explicit byte budget."""

    def __init__(self, max_bytes: int, name: str = "tensor") -> None:
        self.name = str(name)
        self._max_bytes = max(0, int(max_bytes))
        self._entries: "OrderedDict[Any, Dict[str, Any]]" = OrderedDict()
        self._bytes = 0
        self._lock = threading.RLock()
        self.hits = 0
        self.misses = 0
        self.evictions = 0

    @property
    def max_bytes(self) -> int:
        return self._max_bytes

    @max_bytes.setter
    def max_bytes(self, value: int) -> None:
        with self._lock:
            self._max_bytes = max(0, int(value))
            self._trim()

    @property
    def bytes(self) -> int:
        with self._lock:
            return self._bytes

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0

    def _drop(self, key: Any) -> None:
        entry = self._entries.pop(key, None)
        if entry is not None:
            self._bytes -= int(entry["nbytes"])
            self.evictions += 1

    def _trim(self) -> None:
        while self._bytes > self._max_bytes and self._entries:
            key = next(iter(self._entries))
            self._drop(key)

    def get(self, key: Any) -> Any:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                self.misses += 1
                return None
            if not _guards_alive(entry.get("guards")):
                self._drop(key)
                self.misses += 1
                return None
            self._entries.move_to_end(key)
            self.hits += 1
            return entry["value"]

    def put(self, key: Any, value: Any, nbytes: int, guards: Any = ()) -> bool:
        nbytes = max(0, int(nbytes))
        with self._lock:
            if nbytes > self._max_bytes:
                return False
            old = self._entries.pop(key, None)
            if old is not None:
                self._bytes -= int(old["nbytes"])
            self._entries[key] = {
                "value": value,
                "nbytes": nbytes,
                "guards": tuple(guards or ()),
            }
            self._bytes += nbytes
            self._trim()
            return key in self._entries


_REFERENCE_LATENT_CACHE = BoundedTensorLRU(
    _REFERENCE_LATENT_CACHE_MAX_BYTES, "krea2_reference_latent"
)
_RF_CACHE = BoundedTensorLRU(_RF_CACHE_MAX_BYTES, "krea2_rf_schedule")


def _update_digest(digest: Any, value: Any, guards: Optional[List[Any]] = None) -> bool:
    """Hash a value only when its content can be compared unambiguously."""
    if value is None:
        digest.update(b"none")
        return True
    if isinstance(value, bool):
        digest.update(b"bool:" + (b"1" if value else b"0"))
        return True
    if isinstance(value, int):
        digest.update(b"int:" + str(value).encode("ascii"))
        return True
    if isinstance(value, float):
        digest.update(b"float:" + repr(float(value)).encode("ascii"))
        return True
    if isinstance(value, str):
        digest.update(b"str:" + value.encode("utf-8"))
        return True
    if isinstance(value, bytes):
        digest.update(b"bytes:" + value)
        return True
    if torch.is_tensor(value):
        digest.update(b"tensor:")
        digest.update(str(value.dtype).encode("ascii"))
        digest.update(str(tuple(value.shape)).encode("ascii"))
        try:
            data = value.detach()
            if data.dtype == torch.bfloat16:
                data = data.float()
            digest.update(data.to(device="cpu").contiguous().numpy().tobytes())
        except Exception:
            return False
        return True
    if isinstance(value, torch.dtype):
        digest.update(b"dtype:" + str(value).encode("ascii"))
        return True
    if isinstance(value, torch.device):
        digest.update(b"device:" + str(value).encode("ascii"))
        return True
    if isinstance(value, dict):
        digest.update(b"dict:{")
        for key, item in sorted(value.items(), key=lambda pair: repr(pair[0])):
            if not _update_digest(digest, key, guards):
                return False
            digest.update(b"=")
            if not _update_digest(digest, item, guards):
                return False
            digest.update(b",")
        digest.update(b"}")
        return True
    if isinstance(value, (list, tuple)):
        digest.update(b"seq[")
        for item in value:
            if not _update_digest(digest, item, guards):
                return False
            digest.update(b",")
        digest.update(b"]")
        return True
    if callable(value):
        # Callable objects may close over mutable state; identity alone is not
        # enough to prove that two RF evaluations are equivalent.
        return False
    return False


def _lerp(a: float, b: float, t: float) -> float:
    return float(a + (b - a) * t)


def _coerce_sigma_sequence(sigmas: Any) -> Optional[List[float]]:
    if torch.is_tensor(sigmas):
        values = sigmas.detach().float().cpu().flatten().tolist()
    elif isinstance(sigmas, (list, tuple)):
        values = list(sigmas)
    else:
        return None

    out: List[float] = []
    for value in values:
        try:
            sigma = float(value)
        except Exception:
            return None
        if not math.isfinite(sigma):
            return None
        out.append(max(0.0, min(1.0, sigma)))
    return out if out else None


def _repeat_to_batch(x: torch.Tensor, batch: int) -> torch.Tensor:
    if int(x.shape[0]) == int(batch):
        return x
    if hasattr(comfy.utils, "repeat_to_batch_size"):
        return comfy.utils.repeat_to_batch_size(x, int(batch))
    reps = math.ceil(int(batch) / int(x.shape[0]))
    return x.repeat((reps,) + (1,) * (x.ndim - 1))[: int(batch)]


def _clone_model_options(options: Dict[str, Any]) -> Dict[str, Any]:
    out = options.copy()
    out["transformer_options"] = options.get("transformer_options", {}).copy()
    return out


def _describe_value(value: Any) -> str:
    if torch.is_tensor(value):
        return f"Tensor(shape={tuple(value.shape)}, dtype={value.dtype})"
    if isinstance(value, dict):
        keys = ",".join(str(k) for k in list(value.keys())[:8])
        sample = value.get("samples")
        if sample is not None:
            return f"dict(keys=[{keys}], samples={_describe_value(sample)})"
        return f"dict(keys=[{keys}])"
    if isinstance(value, (list, tuple)):
        inner = _describe_value(value[0]) if value else "empty"
        return f"{type(value).__name__}(len={len(value)}, first={inner})"
    return type(value).__name__


def _latent_samples(latent: Any, name: str) -> torch.Tensor:
    value = latent.get("samples") if isinstance(latent, dict) else latent
    while isinstance(value, dict) and "samples" in value:
        value = value.get("samples")
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
        if isinstance(value, dict) and "samples" in value:
            value = value.get("samples")

    if not torch.is_tensor(value):
        raise ValueError(f"{name} must contain tensor samples, got {_describe_value(latent)}.")
    if value.ndim not in (4, 5):
        raise ValueError(f"{name} must be BCHW or BCTHW samples, got {_describe_value(value)}.")
    return value


def _resize_reference_latent(reference: torch.Tensor, target_hw: Tuple[int, int]) -> torch.Tensor:
    """Match a reference latent to the active sampler's spatial grid."""
    if not torch.is_tensor(reference) or reference.ndim not in (4, 5):
        raise ValueError("reference latent must be BCHW or BCTHW samples.")
    target_h, target_w = (int(size) for size in target_hw)
    if target_h <= 0 or target_w <= 0:
        raise ValueError(f"target latent dimensions must be positive, got {(target_h, target_w)}.")
    if tuple(reference.shape[-2:]) == (target_h, target_w):
        return reference

    reference_dtype = reference.dtype
    if reference.ndim == 5:
        batch, channels, frames, height, width = reference.shape
        samples = reference.permute(0, 2, 1, 3, 4).reshape(batch * frames, channels, height, width)
    else:
        samples = reference

    resized = torch.nn.functional.interpolate(
        samples.to(dtype=torch.float32),
        size=(target_h, target_w),
        mode="bilinear",
        align_corners=False,
    ).to(dtype=reference_dtype)
    if reference.ndim == 5:
        resized = resized.reshape(batch, frames, channels, target_h, target_w).permute(0, 2, 1, 3, 4)
    return resized


def _latent_width_height(latent: Any) -> Tuple[int, int]:
    samples = _latent_samples(latent, "target_latent")
    return int(samples.shape[-1] * 8), int(samples.shape[-2] * 8)


def _image_to_bchw(image: torch.Tensor) -> torch.Tensor:
    return image[:, :, :, :3].movedim(-1, 1)


def _bchw_to_image(samples: torch.Tensor) -> torch.Tensor:
    return samples.movedim(1, -1).clamp(0.0, 1.0)


def _fit_image_to_box(
    image: torch.Tensor,
    width: int,
    height: int,
    mode: str,
    method: str,
) -> torch.Tensor:
    samples = _image_to_bchw(image)
    h = int(samples.shape[-2])
    w = int(samples.shape[-1])
    if h <= 0 or w <= 0:
        raise ValueError("reference image has invalid dimensions.")

    if mode == "stretch":
        out = comfy.utils.common_upscale(samples, int(width), int(height), method, "disabled")
        return _bchw_to_image(out)
    if mode == "crop":
        out = comfy.utils.common_upscale(samples, int(width), int(height), method, "center")
        return _bchw_to_image(out)

    scale = min(float(width) / float(w), float(height) / float(h))
    new_w = max(1, min(int(width), int(round(w * scale))))
    new_h = max(1, min(int(height), int(round(h * scale))))
    resized = comfy.utils.common_upscale(samples, new_w, new_h, method, "disabled")
    out = torch.ones(
        (resized.shape[0], resized.shape[1], int(height), int(width)),
        dtype=resized.dtype,
        device=resized.device,
    )
    y0 = max(0, (int(height) - new_h) // 2)
    x0 = max(0, (int(width) - new_w) // 2)
    out[:, :, y0 : y0 + new_h, x0 : x0 + new_w] = resized[:, :, : new_h, : new_w]
    return _bchw_to_image(out)


def _vae_encode_image(vae: Any, image: torch.Tensor) -> Dict[str, torch.Tensor]:
    if vae is None:
        raise RuntimeError("vae input is invalid. Use the Krea2/Qwen image VAE.")
    encoded = vae.encode(image[:, :, :, :3])
    return {"samples": _latent_samples(encoded, "vae.encode(image)")}


def _vae_state_token(vae: Any) -> Tuple[Optional[bytes], Optional[Tuple[Tuple[int, Any], ...]]]:
    patcher = getattr(vae, "patcher", None)
    first_stage = getattr(vae, "first_stage_model", None)
    if patcher is None or first_stage is None:
        return None, None
    patches_uuid = getattr(patcher, "patches_uuid", None)
    patcher_model = getattr(patcher, "model", None)
    if not patches_uuid or patcher_model is None:
        return None, None
    guarded_objects: List[Any] = [vae, patcher, first_stage, patcher_model]
    digest = hashlib.sha256()
    config = {
        name: getattr(vae, name)
        for name in (
            "device", "output_device", "vae_dtype", "latent_dim", "latent_channels",
            "output_channels", "downscale_ratio", "upscale_ratio", "pad_channel_value",
            "not_video", "disable_offload", "handles_tiling", "scale_factor", "shift_factor",
        )
        if hasattr(vae, name)
    }
    if not _update_digest(digest, config, guarded_objects):
        return None, None
    encoder_callables = (
        getattr(vae, "process_input", None),
        getattr(vae, "format_encoded", None),
        getattr(type(vae), "vae_encode_crop_pixels", None),
        getattr(type(first_stage), "encode", None),
    )
    if not _update_digest(digest, encoder_callables, guarded_objects):
        return None, None
    guards = _guard_objects(guarded_objects)
    if guards is None:
        return None, None
    parts = (
        type(vae).__module__,
        type(vae).__qualname__,
        str(id(vae)),
        type(patcher).__module__,
        type(patcher).__qualname__,
        str(id(patcher)),
        type(first_stage).__qualname__,
        str(id(first_stage)),
        type(patcher_model).__qualname__,
        str(id(patcher_model)),
        str(patches_uuid),
        str(getattr(first_stage, "current_weight_patches_uuid", None)),
        str(getattr(vae, "device", None)),
        str(getattr(vae, "vae_dtype", None)),
        digest.hexdigest(),
    )
    return "|".join(parts).encode("utf-8"), guards


def _reference_latent_key(
    vae: Any,
    preview: torch.Tensor,
    width: int,
    height: int,
    fit: str,
    upscale_method: str,
) -> Tuple[Optional[str], Optional[Tuple[Tuple[int, Any], ...]]]:
    state, guards = _vae_state_token(vae)
    if state is None or guards is None:
        return None, None
    digest = hashlib.sha256()
    digest.update(b"krea2-reference-latent-v2")
    digest.update(state)
    digest.update(f"{int(width)}x{int(height)}:{fit}:{upscale_method}".encode("utf-8"))
    if not _update_digest(digest, preview):
        return None, None
    return digest.hexdigest(), guards


def _empty_latent(width: int, height: int, batch_size: int) -> Dict[str, torch.Tensor]:
    latent = torch.zeros([int(batch_size), 16, int(height) // 8, int(width) // 8])
    return {"samples": latent}


_SIZE_PRESETS: Dict[Tuple[str, str], Tuple[int, int]] = {
    ("0.5K", "1:1"): (512, 512),
    ("0.5K", "9:16"): (448, 768),
    ("0.5K", "16:9"): (768, 448),
    ("0.5K", "3:2"): (768, 512),
    ("0.5K", "2:3"): (512, 768),
    ("0.5K", "3:4"): (576, 768),
    ("0.5K", "4:3"): (768, 576),
    ("0.5K", "4:5"): (640, 800),
    ("0.5K", "5:4"): (800, 640),
    ("0.5K", "21:9"): (896, 384),
    ("1K", "1:1"): (1024, 1024),
    ("1K", "9:16"): (768, 1360),
    ("1K", "16:9"): (1360, 768),
    ("1K", "3:2"): (1216, 832),
    ("1K", "2:3"): (832, 1216),
    ("1K", "3:4"): (896, 1200),
    ("1K", "4:3"): (1200, 896),
    ("1K", "4:5"): (928, 1160),
    ("1K", "5:4"): (1160, 928),
    ("1K", "21:9"): (1536, 656),
    ("1.5K", "1:1"): (1536, 1536),
    ("1.5K", "9:16"): (1152, 2048),
    ("1.5K", "16:9"): (2048, 1152),
    ("1.5K", "3:2"): (1888, 1248),
    ("1.5K", "2:3"): (1248, 1888),
    ("1.5K", "3:4"): (1408, 1872),
    ("1.5K", "4:3"): (1872, 1408),
    ("1.5K", "4:5"): (1360, 1696),
    ("1.5K", "5:4"): (1696, 1360),
    ("1.5K", "21:9"): (2304, 984),
    ("2K", "1:1"): (2048, 2048),
    ("2K", "9:16"): (1536, 2736),
    ("2K", "16:9"): (2736, 1536),
    ("2K", "3:2"): (2496, 1664),
    ("2K", "2:3"): (1664, 2496),
    ("2K", "3:4"): (1776, 2368),
    ("2K", "4:3"): (2368, 1776),
    ("2K", "4:5"): (1824, 2280),
    ("2K", "5:4"): (2280, 1824),
    ("2K", "21:9"): (3072, 1320),
}


def _get_attr_path(root: Any, attr_path: str) -> Tuple[Any, bool]:
    obj = root
    for part in attr_path.split("."):
        if obj is None or not hasattr(obj, part):
            return None, False
        obj = getattr(obj, part)
    return obj, True


def _find_diffusion_model(model_patcher: Any) -> Any:
    for path in (
        "model.diffusion_model",
        "model.model.diffusion_model",
        "inner_model.diffusion_model",
        "model.inner_model.diffusion_model",
        "diffusion_model",
    ):
        obj, ok = _get_attr_path(model_patcher, path)
        if ok and obj is not None:
            return obj
    raise RuntimeError("Could not find the Krea2 diffusion model inside the ComfyUI MODEL.")


def _is_krea2_attention_module(module: Any) -> bool:
    required = ("wq", "wk", "wv", "wo", "gate", "qknorm", "heads", "kvheads", "headdim", "forward")
    return all(hasattr(module, attr) for attr in required) and callable(getattr(module, "forward", None))


def _is_krea2_single_stream_block(module: Any) -> bool:
    required = ("mod", "prenorm", "postnorm", "attn", "mlp", "forward")
    return all(hasattr(module, attr) for attr in required) and callable(getattr(module, "forward", None))


def _block_index_from_name(name: str) -> int:
    parts = str(name).split(".")
    if len(parts) >= 2 and parts[0] == "blocks":
        try:
            return int(parts[1])
        except Exception:
            return -1
    return -1


def _is_attention_name(name: str) -> bool:
    parts = str(name).split(".")
    return len(parts) == 3 and parts[0] == "blocks" and parts[2] == "attn"


def _is_block_name(name: str) -> bool:
    parts = str(name).split(".")
    return len(parts) == 2 and parts[0] == "blocks"


def _axes_dims_from_head_dim(head_dim: int) -> List[int]:
    hd = int(head_dim)
    axes = [hd - 12 * (hd // 16), 6 * (hd // 16), 6 * (hd // 16)]
    if sum(axes) != hd or any(v <= 0 for v in axes):
        return [hd]
    return axes


def _image_range(transformer_options: Any, dm: Any, seqlen: int) -> Tuple[int, int]:
    imglen = None
    if isinstance(transformer_options, dict):
        imglen = transformer_options.get("krea2_imglen", None)
    if imglen is None:
        imglen = getattr(dm, "_krea2_style_transfer_last_imglen", None)
    if imglen is None:
        raise RuntimeError("Krea2 Style Transfer could not determine the image token range.")
    imglen_i = max(0, min(int(imglen), int(seqlen)))
    img_s = int(seqlen) - imglen_i
    img_e = int(seqlen)
    if img_e <= img_s:
        raise RuntimeError(f"Krea2 Style Transfer found an empty image token range: imglen={imglen_i}.")
    return img_s, img_e


def _expand_kv_heads(k: torch.Tensor, v: torch.Tensor, q_heads: int) -> Tuple[torch.Tensor, torch.Tensor]:
    kv_heads = int(k.shape[1])
    q_heads = int(q_heads)
    if kv_heads == q_heads:
        return k, v
    if kv_heads <= 0 or q_heads % kv_heads != 0:
        raise RuntimeError(f"Cannot expand KV heads: q_heads={q_heads}, kv_heads={kv_heads}.")
    rep = q_heads // kv_heads
    return k.repeat_interleave(rep, dim=1), v.repeat_interleave(rep, dim=1)


def _parse_blocks(spec: str) -> set[int]:
    active: set[int] = set()
    for raw_part in str(spec or "").replace(";", ",").split(","):
        part = raw_part.strip()
        if not part:
            continue
        if "-" in part:
            start, end = part.split("-", 1)
            start_i = int(start.strip())
            end_i = int(end.strip())
            if end_i < start_i:
                raise ValueError(f"Invalid block range {part!r}.")
            active.update(range(start_i, end_i + 1))
        else:
            active.add(int(part))
    return active


def _build_frequency_scale_vector(
    head_dim: int,
    axes_dims: List[int],
    high_scale: float,
    low_scale: float,
    beta: float,
    device: Any,
    dtype: Any,
) -> torch.Tensor:
    if not axes_dims or sum(int(x) for x in axes_dims) != int(head_dim):
        axes_dims = [int(head_dim)]

    def curve(n_pairs: int) -> torch.Tensor:
        if n_pairs <= 1:
            x = torch.zeros(1, device=device, dtype=torch.float32)
        else:
            x = torch.linspace(0.0, 1.0, n_pairs, device=device, dtype=torch.float32)
        return float(high_scale) + (float(low_scale) - float(high_scale)) * x.pow(float(beta))

    pieces: List[torch.Tensor] = []
    has_axis0 = len(axes_dims) >= 2
    for axis_idx, axis_dim in enumerate(int(v) for v in axes_dims):
        pairs = axis_dim // 2
        if pairs <= 0:
            pieces.append(torch.ones(axis_dim, device=device, dtype=dtype))
            continue
        if has_axis0 and axis_idx == 0:
            pair_scales = torch.full((pairs,), float(low_scale), device=device, dtype=torch.float32)
        else:
            pair_scales = curve(pairs)
        pieces.append(pair_scales.to(dtype=dtype).repeat_interleave(2))
        if axis_dim % 2:
            pieces.append(torch.ones(1, device=device, dtype=dtype))
    out = torch.cat(pieces, dim=0)
    if int(out.numel()) >= int(head_dim):
        return out[: int(head_dim)]
    return torch.nn.functional.pad(out, (0, int(head_dim) - int(out.numel())), value=1.0)


def _adain(target: torch.Tensor, style: torch.Tensor, eps: float = 1e-6) -> torch.Tensor:
    t_mean = target.mean(dim=1, keepdim=True)
    s_mean = style.mean(dim=1, keepdim=True)
    t_std = target.float().var(dim=1, keepdim=True, unbiased=False).add(eps).sqrt().to(target.dtype)
    s_std = style.float().var(dim=1, keepdim=True, unbiased=False).add(eps).sqrt().to(target.dtype)
    return (target - t_mean) / t_std * s_std + s_mean


def _cross_batch_adain_qk(
    q: torch.Tensor,
    k: torch.Tensor,
    target_b: int,
    ranges: List[Tuple[int, int]],
    strength: float,
) -> Tuple[torch.Tensor, torch.Tensor]:
    alpha = max(0.0, min(1.0, float(strength)))
    if alpha <= 0.0 or int(target_b) <= 0 or int(q.shape[0]) < int(target_b) * 2:
        return q, k
    q_out = q.clone()
    k_out = k.clone()
    for start, end in ranges:
        s = max(0, min(int(start), int(q_out.shape[1])))
        e = max(s, min(int(end), int(q_out.shape[1])))
        if e <= s:
            continue
        q_t = q_out[:target_b, s:e]
        q_r = q_out[target_b : target_b * 2, s:e]
        k_t = k_out[:target_b, s:e]
        k_r = k_out[target_b : target_b * 2, s:e]
        q_out[:target_b, s:e] = q_t * (1.0 - alpha) + _adain(q_t, q_r) * alpha
        k_out[:target_b, s:e] = k_t * (1.0 - alpha) + _adain(k_t, k_r) * alpha
    return q_out, k_out


def _adain_blend(target: torch.Tensor, style: torch.Tensor, alpha: torch.Tensor) -> torch.Tensor:
    styled = _adain(target, style)
    while alpha.ndim < target.ndim:
        alpha = alpha.unsqueeze(0)
    return target * (1.0 - alpha) + styled * alpha


def _cross_batch_stat_transfer(
    x: torch.Tensor,
    target_b: int,
    ranges: List[Tuple[int, int]],
    alpha_vec: torch.Tensor,
) -> torch.Tensor:
    if int(target_b) <= 0 or int(x.shape[0]) < int(target_b) * 2:
        return x
    if float(alpha_vec.detach().float().abs().max().cpu()) <= 0.0:
        return x
    x_bshd = x.movedim(1, 2).clone()
    alpha = alpha_vec.view(1, 1, 1, int(alpha_vec.shape[-1])).to(device=x.device, dtype=x.dtype)
    for start, end in ranges:
        s = max(0, min(int(start), int(x_bshd.shape[1])))
        e = max(s, min(int(end), int(x_bshd.shape[1])))
        if e <= s:
            continue
        target = x_bshd[:target_b, s:e]
        style = x_bshd[target_b : target_b * 2, s:e]
        x_bshd[:target_b, s:e] = _adain_blend(target, style, alpha)
    return x_bshd.movedim(1, 2)


def _pool_sequence_tokens(x: torch.Tensor, count: int) -> torch.Tensor:
    count_i = max(1, int(count))
    seq = int(x.shape[2])
    if seq <= count_i:
        return x
    pieces: List[torch.Tensor] = []
    for idx in range(count_i):
        start = int(round(idx * seq / count_i))
        end = int(round((idx + 1) * seq / count_i))
        end = max(start + 1, min(end, seq))
        pieces.append(x[:, :, start:end, :].mean(dim=2, keepdim=True))
    return torch.cat(pieces, dim=2)


def _adain_tokens_bhld(target: torch.Tensor, style: torch.Tensor, eps: float = 1e-6) -> torch.Tensor:
    t_mean = target.mean(dim=2, keepdim=True)
    s_mean = style.mean(dim=2, keepdim=True)
    t_std = target.float().var(dim=2, keepdim=True, unbiased=False).add(eps).sqrt().to(target.dtype)
    s_std = style.float().var(dim=2, keepdim=True, unbiased=False).add(eps).sqrt().to(target.dtype)
    return (target - t_mean) / t_std * s_std + s_mean


def _make_controlled_ref_value(
    target_v: torch.Tensor,
    ref_v: torch.Tensor,
    mode: str,
    value_adain_strength: float,
    ref_value_mix: float,
) -> torch.Tensor:
    mode_s = str(mode)
    adain_alpha = max(0.0, min(1.5, float(value_adain_strength)))
    ref_mix = max(0.0, min(1.0, float(ref_value_mix)))
    if mode_s == "raw_reference":
        return ref_v
    if mode_s == "target":
        base = target_v
    elif mode_s == "ref_mean":
        base = ref_v.mean(dim=2, keepdim=True).expand_as(ref_v)
    else:
        styled_target = _adain_tokens_bhld(target_v, ref_v)
        base = target_v * (1.0 - adain_alpha) + styled_target * adain_alpha
    if mode_s == "target_adain_plus_ref":
        return base * (1.0 - ref_mix) + ref_v * ref_mix
    return base


def _global_rms(x: torch.Tensor) -> torch.Tensor:
    dims = tuple(range(1, x.ndim))
    return x.float().pow(2).mean(dim=dims, keepdim=True).add(1e-6).sqrt().to(dtype=x.dtype)


def _token_rms_cap(x: torch.Tensor, cap: float) -> torch.Tensor:
    cap_f = float(cap)
    if cap_f <= 0.0:
        return x
    rms = x.float().pow(2).mean(dim=-1, keepdim=True).add(1e-6).sqrt()
    scale = (cap_f / rms).clamp(max=1.0).to(device=x.device, dtype=x.dtype)
    return x * scale


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    if abs(float(edge1) - float(edge0)) < 1e-6:
        return 1.0 if float(x) >= float(edge1) else 0.0
    t = (float(x) - float(edge0)) / (float(edge1) - float(edge0))
    t = max(0.0, min(1.0, t))
    return t * t * (3.0 - 2.0 * t)


def _stage_weights(
    ref_weights: List[float],
    progress: float,
    schedule: str,
    stage_blend: float,
    late_release: float,
    stage_shift: int = 0,
    first_phase_ratio: float = 0.5,
) -> List[float]:
    count = max(1, len(ref_weights))
    base = [max(0.0, float(w)) for w in ref_weights[:count]]
    total = sum(base)
    if total <= 0.0:
        base = [1.0 / float(count)] * count
    else:
        base = [w / total for w in base]
    if count == 1:
        return [1.0]

    p = max(0.0, min(1.0, float(progress)))
    release = max(0.0, min(0.95, float(late_release)))
    if release > 0.0 and p >= 1.0 - release:
        fade = 1.0 - _smoothstep(1.0 - release, 1.0, p)
    else:
        fade = 1.0

    schedule_s = str(schedule)
    if schedule_s == "reverse":
        order = list(reversed(range(count)))
    elif schedule_s == "weighted":
        order = list(range(count))
    else:
        order = list(range(count))
    if count > 1:
        shift = int(stage_shift) % count
        order = order[shift:] + order[:shift]

    if schedule_s == "alternating":
        selected = min(count - 1, int(math.floor(p * float(count * 2))) % count)
        out = [0.0] * count
        out[order[selected]] = 1.0 * fade
        return out

    blend = max(0.0, min(0.95, float(stage_blend)))
    if blend > 0.0:
        if schedule_s == "weighted":
            edges = [0.0]
            acc = 0.0
            for w in base:
                acc += w
                edges.append(min(1.0, acc))
            centers = [(edges[i] + edges[i + 1]) * 0.5 for i in range(count)]
        else:
            centers = [float(i) / float(max(1, count - 1)) for i in range(count)]
        sigma = max(1e-4, blend * 0.85)
        raw = []
        for center in centers:
            d = (p - center) / sigma
            raw.append(math.exp(-0.5 * d * d))
        total_raw = sum(raw)
        if total_raw > 1e-8:
            out = [0.0] * count
            for idx, value in enumerate(raw):
                out[order[idx]] = float(value / total_raw) * fade
            return out

    if schedule_s == "weighted":
        edges = [0.0]
        acc = 0.0
        for w in base:
            acc += w
            edges.append(min(1.0, acc))
        selected = count - 1
        local_t = 0.0
        for idx in range(count):
            if p <= edges[idx + 1] or idx == count - 1:
                selected = idx
                span = max(1e-6, edges[idx + 1] - edges[idx])
                local_t = (p - edges[idx]) / span
                break
    elif count == 2:
        split = max(0.05, min(0.95, float(first_phase_ratio)))
        selected = 0 if p < split else 1
        local_t = p / split if selected == 0 else (p - split) / max(1e-6, 1.0 - split)
    else:
        phase = p * float(count)
        selected = min(count - 1, int(math.floor(phase)))
        local_t = phase - float(selected)

    selected = order[selected]
    out = [0.0] * count
    out[selected] = 1.0

    if fade < 1.0:
        out = [w * fade for w in out]
    return out


def _primary_reference_index(primary_reference: Any, count: int) -> int:
    count = max(1, int(count))
    try:
        idx = int(str(primary_reference).strip()) - 1
    except Exception:
        idx = 0
    if idx < 0 or idx >= count:
        return 0
    return idx


def _stage_shift_for_primary(count: int, schedule: str, primary_idx: int) -> int:
    count = max(1, int(count))
    primary_idx = _primary_reference_index(primary_idx + 1, count)
    if count <= 1:
        return 0
    if str(schedule) == "reverse":
        order = list(reversed(range(count)))
    else:
        order = list(range(count))
    try:
        return int(order.index(primary_idx))
    except ValueError:
        return 0


def _late_release_fade(progress: float, late_release: float) -> float:
    p = max(0.0, min(1.0, float(progress)))
    release = max(0.0, min(0.95, float(late_release)))
    if release <= 0.0 or p < 1.0 - release:
        return 1.0
    return 1.0 - _smoothstep(1.0 - release, 1.0, p)


def _patch_krea2_attention(dm: Any) -> Tuple[int, int]:
    txtmlp = getattr(dm, "txtmlp", None)
    if txtmlp is not None and not hasattr(txtmlp, "_krea2_style_transfer_orig_txtmlp_forward"):
        txtmlp._krea2_style_transfer_orig_txtmlp_forward = txtmlp.forward
        orig_txtmlp = txtmlp._krea2_style_transfer_orig_txtmlp_forward

        def patched_txtmlp_forward(self, x):
            dm._krea2_style_transfer_last_txtlen = int(x.shape[1]) if torch.is_tensor(x) and x.ndim >= 2 else None
            return orig_txtmlp(x)

        txtmlp.forward = types.MethodType(patched_txtmlp_forward, txtmlp)

    for name, module in dm.named_modules():
        if not _is_block_name(name) or not _is_krea2_single_stream_block(module):
            continue
        if hasattr(module, "_krea2_style_transfer_orig_block_forward"):
            continue
        module._krea2_style_transfer_orig_block_forward = module.forward
        orig_block = module._krea2_style_transfer_orig_block_forward

        def make_block_forward(orig):
            def patched_block_forward(self, x, vec, freqs, mask=None, timestep_zero_index=None, transformer_options={}):
                if isinstance(transformer_options, dict) and "krea2_imglen" not in transformer_options:
                    cfg = transformer_options.get(_CONFIG_KEY)
                    txtlen = getattr(dm, "_krea2_style_transfer_last_txtlen", None)
                    if cfg and cfg.get("enabled") and txtlen is not None and torch.is_tensor(x) and x.ndim >= 2:
                        imglen = int(x.shape[1]) - int(txtlen)
                        if imglen > 0:
                            transformer_options = transformer_options.copy()
                            transformer_options["krea2_imglen"] = imglen
                            dm._krea2_style_transfer_last_imglen = imglen
                kwargs = {
                    "mask": mask,
                    "transformer_options": transformer_options,
                }
                if timestep_zero_index is not None:
                    kwargs["timestep_zero_index"] = timestep_zero_index
                return orig(x, vec, freqs, **kwargs)

            return patched_block_forward

        module.forward = types.MethodType(make_block_forward(orig_block), module)

    matched = 0
    installed = 0
    for name, module in dm.named_modules():
        if not _is_attention_name(name) or not _is_krea2_attention_module(module):
            continue
        matched += 1
        if hasattr(module, "_krea2_style_transfer_orig_attention_forward"):
            module.forward = module._krea2_style_transfer_orig_attention_forward
        else:
            module._krea2_style_transfer_orig_attention_forward = module.forward
        original_forward = module._krea2_style_transfer_orig_attention_forward

        def make_forward(orig, module_name: str):
            def patched_forward(self, x, freqs=None, mask=None, transformer_options={}):
                cfg = transformer_options.get(_CONFIG_KEY) if isinstance(transformer_options, dict) else None
                if not cfg or not cfg.get("enabled"):
                    return orig(x, freqs=freqs, mask=mask, transformer_options=transformer_options)
                if mask is not None:
                    return orig(x, freqs=freqs, mask=mask, transformer_options=transformer_options)
                if not torch.is_tensor(x) or x.ndim != 3:
                    return orig(x, freqs=freqs, mask=mask, transformer_options=transformer_options)

                target_b = int(cfg.get("target_batch", 0))
                if target_b <= 0 or int(x.shape[0]) < target_b * 2:
                    return orig(x, freqs=freqs, mask=mask, transformer_options=transformer_options)

                block_idx = int(transformer_options.get("block_index", _block_index_from_name(module_name)))
                active_blocks = cfg.get("active_blocks", set())
                if active_blocks and block_idx not in active_blocks:
                    return orig(x, freqs=freqs, mask=mask, transformer_options=transformer_options)

                bsz, seqlen, _ = x.shape
                img_s, img_e = _image_range(transformer_options, dm, seqlen)
                q_heads = int(getattr(self, "heads", 0))
                kv_heads = int(getattr(self, "kvheads", q_heads))
                head_dim = int(getattr(self, "headdim", 0))
                if q_heads <= 0 or kv_heads <= 0 or head_dim <= 0:
                    return orig(x, freqs=freqs, mask=mask, transformer_options=transformer_options)

                q = rearrange(self.wq(x), "B L (H D) -> B H L D", H=q_heads)
                k = rearrange(self.wk(x), "B L (H D) -> B H L D", H=kv_heads)
                v = rearrange(self.wv(x), "B L (H D) -> B H L D", H=kv_heads)
                gate = self.gate(x)

                q, k = self.qknorm(q, k)
                if freqs is not None:
                    q, k = apply_rope(q, k, freqs)
                k, v = _expand_kv_heads(k, v, q_heads)

                adain_strength = float(cfg.get("adain_strength", 0.0))
                if adain_strength > 0.0:
                    q_bshd = q.movedim(1, 2)
                    k_bshd = k.movedim(1, 2)
                    q_bshd, k_bshd = _cross_batch_adain_qk(
                        q_bshd,
                        k_bshd,
                        target_b,
                        [(img_s, img_e)],
                        adain_strength,
                    )
                    q = q_bshd.movedim(1, 2)
                    k = k_bshd.movedim(1, 2)

                progress = float(cfg.get("progress", 0.0))
                high_scale = _lerp(float(cfg["high_scale_start"]), float(cfg["high_scale_end"]), progress)
                low_scale = _lerp(float(cfg["low_scale_start"]), float(cfg["low_scale_end"]), progress)
                scale_vec = _build_frequency_scale_vector(
                    head_dim,
                    _axes_dims_from_head_dim(head_dim),
                    high_scale,
                    low_scale,
                    float(cfg.get("beta", 2.5)),
                    k.device,
                    k.dtype,
                ).view(1, 1, 1, head_dim)

                if str(cfg.get("method", "token")) == "controlled":
                    native_target = optimized_attention_masked(
                        q[:target_b],
                        k[:target_b],
                        v[:target_b],
                        q_heads,
                        mask=None,
                        skip_reshape=True,
                        transformer_options=transformer_options,
                    )
                    ref_k_strength = max(0.0, float(cfg.get("ref_k_strength", 1.0)))
                    ref_k = k[target_b : target_b * 2, :, img_s:img_e, :] * scale_vec * ref_k_strength
                    ref_v_raw = v[target_b : target_b * 2, :, img_s:img_e, :]
                    target_v_img = v[:target_b, :, img_s:img_e, :]
                    ref_v = _make_controlled_ref_value(
                        target_v_img,
                        ref_v_raw,
                        str(cfg.get("value_mode", "target_adain")),
                        float(cfg.get("value_adain_strength", 0.65)),
                        float(cfg.get("ref_value_mix", 0.0)),
                    )
                    k_target = torch.cat([k[:target_b], ref_k], dim=2)
                    v_target = torch.cat([v[:target_b], ref_v], dim=2)

                    styled_target = optimized_attention_masked(
                        q[:target_b],
                        k_target,
                        v_target,
                        q_heads,
                        mask=None,
                        skip_reshape=True,
                        transformer_options=transformer_options,
                    )
                    mix = max(0.0, min(1.0, float(cfg.get("attention_mix", 1.0))))
                    out_target = native_target * (1.0 - mix) + styled_target * mix
                    out_ref = optimized_attention_masked(
                        q[target_b : target_b * 2],
                        k[target_b : target_b * 2],
                        v[target_b : target_b * 2],
                        q_heads,
                        mask=None,
                        skip_reshape=True,
                        transformer_options=transformer_options,
                    )

                    outs = [out_target, out_ref]
                    if bsz > target_b * 2:
                        out_extra = optimized_attention_masked(
                            q[target_b * 2 :],
                            k[target_b * 2 :],
                            v[target_b * 2 :],
                            q_heads,
                            mask=None,
                            skip_reshape=True,
                            transformer_options=transformer_options,
                        )
                        outs.append(out_extra)

                    out = torch.cat(outs, dim=0)
                    if out.shape != gate.shape:
                        return orig(x, freqs=freqs, mask=mask, transformer_options=transformer_options)
                    return self.wo(out * torch.sigmoid(gate))

                if str(cfg.get("method", "token")) == "multi_delta":
                    ref_count = max(1, int(cfg.get("ref_count", 1)))
                    if int(x.shape[0]) < target_b * (1 + ref_count):
                        return orig(x, freqs=freqs, mask=mask, transformer_options=transformer_options)
                    native_target = optimized_attention_masked(
                        q[:target_b],
                        k[:target_b],
                        v[:target_b],
                        q_heads,
                        mask=None,
                        skip_reshape=True,
                        transformer_options=transformer_options,
                    )
                    weights = cfg.get("ref_weights", None)
                    if not isinstance(weights, (list, tuple)) or len(weights) < ref_count:
                        weights = [1.0 / float(ref_count)] * ref_count
                    weights_f = [max(0.0, float(weights[i])) for i in range(ref_count)]
                    total_w = sum(weights_f)
                    if total_w <= 0.0:
                        weights_f = [1.0 / float(ref_count)] * ref_count
                    else:
                        weights_f = [w / total_w for w in weights_f]
                    ref_k_strength = max(0.0, float(cfg.get("ref_k_strength", 1.0)))
                    delta_clip = max(0.0, float(cfg.get("delta_clip", 0.0)))
                    token_rms_cap = max(0.0, float(cfg.get("token_rms_cap", 0.0)))
                    fusion_mode = str(cfg.get("fusion_mode", "rms_balanced"))
                    dominance_softness = max(0.01, float(cfg.get("dominance_softness", 0.35)))
                    consensus_power = max(0.0, float(cfg.get("consensus_power", 0.0)))
                    rotate_strength = max(0.0, min(1.0, float(cfg.get("rotate_strength", 0.0))))
                    stage_schedule = str(cfg.get("stage_schedule", "forward"))
                    stage_blend = max(0.0, min(0.95, float(cfg.get("stage_blend", 0.15))))
                    late_release = max(0.0, min(0.95, float(cfg.get("late_release", 0.0))))
                    stage_shift = int(cfg.get("stage_shift", 0))
                    resolution_gain = max(0.0, min(2.0, float(cfg.get("resolution_gain", 0.0))))
                    per_ref_k_strengths = cfg.get("per_ref_k_strengths", None)
                    ref_token_count = max(1, img_e - img_s)
                    resolution_mult = max(1.0, min(3.0, (float(ref_token_count) / 5376.0) ** (0.5 * resolution_gain)))
                    target_v_img = v[:target_b, :, img_s:img_e, :]
                    deltas: List[torch.Tensor] = []
                    out_refs = []
                    for ref_idx in range(ref_count):
                        start_b = target_b * (1 + ref_idx)
                        end_b = start_b + target_b
                        if isinstance(per_ref_k_strengths, (list, tuple)) and ref_idx < len(per_ref_k_strengths):
                            ref_k_scale = max(0.0, float(per_ref_k_strengths[ref_idx]))
                        else:
                            ref_k_scale = ref_k_strength
                        ref_k = k[start_b:end_b, :, img_s:img_e, :] * scale_vec * ref_k_scale * resolution_mult
                        ref_v_raw = v[start_b:end_b, :, img_s:img_e, :]
                        ref_v = _make_controlled_ref_value(
                            target_v_img,
                            ref_v_raw,
                            "target_adain_plus_ref",
                            float(cfg.get("value_adain_strength", 0.65)),
                            float(cfg.get("ref_value_mix", 1.0)),
                        )
                        k_target = torch.cat([k[:target_b], ref_k], dim=2)
                        v_target = torch.cat([v[:target_b], ref_v], dim=2)
                        styled = optimized_attention_masked(
                            q[:target_b],
                            k_target,
                            v_target,
                            q_heads,
                            mask=None,
                            skip_reshape=True,
                            transformer_options=transformer_options,
                        )
                        delta = styled - native_target
                        if delta_clip > 0.0:
                            delta = delta.clamp(min=-delta_clip, max=delta_clip)
                        if token_rms_cap > 0.0:
                            delta = _token_rms_cap(delta, token_rms_cap)
                        deltas.append(delta)
                        out_ref = optimized_attention_masked(
                            q[start_b:end_b],
                            k[start_b:end_b],
                            v[start_b:end_b],
                            q_heads,
                            mask=None,
                            skip_reshape=True,
                            transformer_options=transformer_options,
                        )
                        out_refs.append(out_ref)

                    weights_t = torch.tensor(weights_f[: len(deltas)], device=native_target.device, dtype=native_target.dtype)
                    weights_t = weights_t / weights_t.sum().clamp(min=1e-6)
                    if fusion_mode == "plain_average" or len(deltas) <= 1:
                        delta_sum = torch.zeros_like(native_target)
                        for ref_idx, delta in enumerate(deltas):
                            delta_sum = delta_sum + delta * weights_t[ref_idx]
                    elif fusion_mode == "step_cycle":
                        stage_w = _stage_weights(
                            weights_f[: len(deltas)],
                            progress,
                            stage_schedule,
                            stage_blend,
                            late_release,
                            stage_shift,
                            float(cfg.get("first_phase_ratio", 0.5)),
                        )
                        avg_delta = torch.zeros_like(native_target)
                        for ref_idx, delta in enumerate(deltas):
                            avg_delta = avg_delta + delta * weights_t[ref_idx]
                        stage_delta = torch.zeros_like(native_target)
                        for ref_idx, delta in enumerate(deltas):
                            stage_delta = stage_delta + delta * float(stage_w[ref_idx])
                        delta_sum = avg_delta * (1.0 - rotate_strength) + stage_delta * rotate_strength
                        delta_sum = delta_sum * _late_release_fade(progress, late_release)
                    elif fusion_mode == "block_cycle":
                        selected = int(block_idx) % len(deltas)
                        avg_delta = torch.zeros_like(native_target)
                        for ref_idx, delta in enumerate(deltas):
                            avg_delta = avg_delta + delta * weights_t[ref_idx]
                        delta_sum = avg_delta * (1.0 - rotate_strength) + deltas[selected] * rotate_strength
                    else:
                        rms_values = torch.stack([_global_rms(delta) for delta in deltas], dim=0)
                        mean_rms = rms_values.mean(dim=0, keepdim=True).clamp(min=1e-6)
                        balanced = [
                            delta * (mean_rms[0] / rms_values[ref_idx]).clamp(max=1.0 + dominance_softness)
                            for ref_idx, delta in enumerate(deltas)
                        ]
                        if fusion_mode == "consensus":
                            signs = torch.stack([delta.sign() for delta in balanced], dim=0)
                            agreement = signs.mean(dim=0).abs().pow(consensus_power if consensus_power > 0.0 else 1.0)
                            delta_sum = torch.zeros_like(native_target)
                            for ref_idx, delta in enumerate(balanced):
                                delta_sum = delta_sum + delta * weights_t[ref_idx]
                            delta_sum = delta_sum * agreement
                        else:
                            delta_sum = torch.zeros_like(native_target)
                            for ref_idx, delta in enumerate(balanced):
                                delta_sum = delta_sum + delta * weights_t[ref_idx]
                    mix = max(0.0, min(1.0, float(cfg.get("attention_mix", 1.0))))
                    out_target = native_target + delta_sum * mix
                    outs = [out_target] + out_refs
                    if bsz > target_b * (1 + ref_count):
                        out_extra = optimized_attention_masked(
                            q[target_b * (1 + ref_count) :],
                            k[target_b * (1 + ref_count) :],
                            v[target_b * (1 + ref_count) :],
                            q_heads,
                            mask=None,
                            skip_reshape=True,
                            transformer_options=transformer_options,
                        )
                        outs.append(out_extra)
                    out = torch.cat(outs, dim=0)
                    if out.shape != gate.shape:
                        return orig(x, freqs=freqs, mask=mask, transformer_options=transformer_options)
                    return self.wo(out * torch.sigmoid(gate))

                if str(cfg.get("method", "token")) == "stat":
                    stat_strength = max(0.0, float(cfg.get("stat_strength", 0.0)))
                    value_strength = max(0.0, float(cfg.get("value_stat_strength", 0.0)))
                    token_mix = max(0.0, min(1.0, float(cfg.get("token_mix", 0.0))))
                    low_freq_strength = max(0.0, float(cfg.get("low_freq_strength", 1.0)))
                    high_freq_strength = max(0.0, float(cfg.get("high_freq_strength", 0.35)))
                    stat_alpha = _build_frequency_scale_vector(
                        head_dim,
                        _axes_dims_from_head_dim(head_dim),
                        high_freq_strength,
                        low_freq_strength,
                        float(cfg.get("beta", 2.5)),
                        k.device,
                        torch.float32,
                    ).clamp(0.0, 2.0)
                    stat_alpha = (stat_alpha * stat_strength).clamp(0.0, 1.5).to(dtype=k.dtype)
                    q = _cross_batch_stat_transfer(q, target_b, [(img_s, img_e)], stat_alpha)
                    k = _cross_batch_stat_transfer(k, target_b, [(img_s, img_e)], stat_alpha)
                    if value_strength > 0.0:
                        v_alpha = (stat_alpha.float() * value_strength).clamp(0.0, 1.5).to(dtype=v.dtype)
                        v = _cross_batch_stat_transfer(v, target_b, [(img_s, img_e)], v_alpha)

                    out_target = optimized_attention_masked(
                        q[:target_b],
                        k[:target_b],
                        v[:target_b],
                        q_heads,
                        mask=None,
                        skip_reshape=True,
                        transformer_options=transformer_options,
                    )
                    if token_mix > 0.0:
                        prototype_tokens = max(1, int(cfg.get("prototype_tokens", 16)))
                        ref_k_proto = _pool_sequence_tokens(k[target_b : target_b * 2, :, img_s:img_e, :], prototype_tokens)
                        ref_v_proto = _pool_sequence_tokens(v[target_b : target_b * 2, :, img_s:img_e, :], prototype_tokens)
                        k_target = torch.cat([k[:target_b], ref_k_proto], dim=2)
                        v_target = torch.cat([v[:target_b], ref_v_proto], dim=2)
                        token_target = optimized_attention_masked(
                            q[:target_b],
                            k_target,
                            v_target,
                            q_heads,
                            mask=None,
                            skip_reshape=True,
                            transformer_options=transformer_options,
                        )
                        out_target = out_target * (1.0 - token_mix) + token_target * token_mix

                    out_ref = optimized_attention_masked(
                        q[target_b : target_b * 2],
                        k[target_b : target_b * 2],
                        v[target_b : target_b * 2],
                        q_heads,
                        mask=None,
                        skip_reshape=True,
                        transformer_options=transformer_options,
                    )
                    outs = [out_target, out_ref]
                    if bsz > target_b * 2:
                        out_extra = optimized_attention_masked(
                            q[target_b * 2 :],
                            k[target_b * 2 :],
                            v[target_b * 2 :],
                            q_heads,
                            mask=None,
                            skip_reshape=True,
                            transformer_options=transformer_options,
                        )
                        outs.append(out_extra)

                    out = torch.cat(outs, dim=0)
                    if out.shape != gate.shape:
                        return orig(x, freqs=freqs, mask=mask, transformer_options=transformer_options)
                    return self.wo(out * torch.sigmoid(gate))

                native_target = optimized_attention_masked(
                    q[:target_b],
                    k[:target_b],
                    v[:target_b],
                    q_heads,
                    mask=None,
                    skip_reshape=True,
                    transformer_options=transformer_options,
                )

                ref_k = k[target_b : target_b * 2, :, img_s:img_e, :] * scale_vec
                ref_v = v[target_b : target_b * 2, :, img_s:img_e, :]
                k_target = torch.cat([k[:target_b], ref_k], dim=2)
                v_target = torch.cat([v[:target_b], ref_v], dim=2)

                styled_target = optimized_attention_masked(
                    q[:target_b],
                    k_target,
                    v_target,
                    q_heads,
                    mask=None,
                    skip_reshape=True,
                    transformer_options=transformer_options,
                )
                mix = max(0.0, min(1.0, float(cfg.get("attention_mix", 1.0))))
                out_target = native_target * (1.0 - mix) + styled_target * mix
                out_ref = optimized_attention_masked(
                    q[target_b : target_b * 2],
                    k[target_b : target_b * 2],
                    v[target_b : target_b * 2],
                    q_heads,
                    mask=None,
                    skip_reshape=True,
                    transformer_options=transformer_options,
                )

                outs = [out_target, out_ref]
                if bsz > target_b * 2:
                    out_extra = optimized_attention_masked(
                        q[target_b * 2 :],
                        k[target_b * 2 :],
                        v[target_b * 2 :],
                        q_heads,
                        mask=None,
                        skip_reshape=True,
                        transformer_options=transformer_options,
                    )
                    outs.append(out_extra)

                out = torch.cat(outs, dim=0)
                if out.shape != gate.shape:
                    return orig(x, freqs=freqs, mask=mask, transformer_options=transformer_options)
                return self.wo(out * torch.sigmoid(gate))

            return patched_forward

        module.forward = types.MethodType(make_forward(original_forward, name), module)
        installed += 1

    if installed <= 0:
        raise RuntimeError("Krea2 Style Transfer found no compatible blocks.N.attn modules.")
    return matched, installed


_TEXT_CONDITIONING_KEYS = {
    "c_crossattn",
    "crossattn",
    "context",
    "cap_feats",
    "cond",
    "encoder_hidden_states",
    "txt",
    "text",
    "text_embeddings",
}
_POOLED_CONDITIONING_KEYS = {"pooled_output", "clip_pooled", "pooled", "y", "vector"}
_MASK_CONDITIONING_KEYS = {"attention_mask", "crossattn_mask", "c_crossattn_mask", "cap_mask", "cond_mask", "mask"}
_NUM_TOKEN_KEYS = {"num_tokens", "tokens_num", "n_tokens", "cap_num_tokens"}
_META_ALIASES = {
    "pooled_output": ("pooled_output", "clip_pooled", "pooled", "y", "vector"),
    "clip_pooled": ("clip_pooled", "pooled_output", "pooled", "y", "vector"),
    "pooled": ("pooled", "pooled_output", "clip_pooled", "y", "vector"),
    "y": ("y", "pooled_output", "clip_pooled", "pooled", "vector"),
    "vector": ("vector", "pooled_output", "clip_pooled", "pooled", "y"),
    "attention_mask": ("attention_mask", "crossattn_mask", "c_crossattn_mask", "cap_mask", "mask"),
    "crossattn_mask": ("crossattn_mask", "attention_mask", "c_crossattn_mask", "cap_mask", "mask"),
    "c_crossattn_mask": ("c_crossattn_mask", "attention_mask", "crossattn_mask", "cap_mask", "mask"),
    "cap_mask": ("cap_mask", "attention_mask", "crossattn_mask", "c_crossattn_mask", "mask"),
    "mask": ("mask", "attention_mask", "crossattn_mask", "c_crossattn_mask", "cap_mask"),
    "num_tokens": ("num_tokens", "tokens_num", "n_tokens", "cap_num_tokens"),
    "tokens_num": ("tokens_num", "num_tokens", "n_tokens", "cap_num_tokens"),
    "n_tokens": ("n_tokens", "num_tokens", "tokens_num", "cap_num_tokens"),
    "cap_num_tokens": ("cap_num_tokens", "num_tokens", "tokens_num", "n_tokens"),
}


def _pad_or_truncate_tokens(x: torch.Tensor, target_tokens: int) -> torch.Tensor:
    if x.ndim < 2:
        return x
    cur = int(x.shape[1])
    if cur == int(target_tokens):
        return x
    if cur > int(target_tokens):
        return x[:, : int(target_tokens), ...]
    pad_shape = list(x.shape)
    pad_shape[1] = int(target_tokens) - cur
    pad = torch.zeros(pad_shape, device=x.device, dtype=x.dtype)
    return torch.cat([x, pad], dim=1)


def _first_tensor_in_conditioning_entry(entry: Any) -> Tuple[Optional[torch.Tensor], Dict[str, Any]]:
    meta: Dict[str, Any] = {}
    if torch.is_tensor(entry):
        return entry, meta
    if isinstance(entry, dict):
        meta.update(entry)
        for key in ("c_crossattn", "crossattn", "conditioning", "cond", "context", "cap_feats"):
            value = entry.get(key)
            if torch.is_tensor(value):
                return value, meta
        for value in entry.values():
            if torch.is_tensor(value) and value.ndim >= 2:
                return value, meta
        return None, meta
    if isinstance(entry, (list, tuple)):
        cond: Optional[torch.Tensor] = None
        for item in entry:
            if torch.is_tensor(item) and cond is None:
                cond = item
            elif isinstance(item, dict):
                meta.update(item)
        if cond is not None:
            return cond, meta
        for item in entry:
            cond, nested_meta = _first_tensor_in_conditioning_entry(item)
            if nested_meta:
                meta.update(nested_meta)
            if cond is not None:
                return cond, meta
    return None, meta


def _extract_reference_conditioning(ref_conditioning: Any) -> Tuple[Optional[torch.Tensor], Dict[str, Any]]:
    if ref_conditioning is None:
        return None, {}
    if torch.is_tensor(ref_conditioning) or isinstance(ref_conditioning, dict):
        return _first_tensor_in_conditioning_entry(ref_conditioning)
    if isinstance(ref_conditioning, (list, tuple)):
        merged_meta: Dict[str, Any] = {}
        for entry in ref_conditioning:
            cond, meta = _first_tensor_in_conditioning_entry(entry)
            if meta:
                merged_meta.update(meta)
            if cond is not None:
                return cond, merged_meta
        return None, merged_meta
    return None, {}


def _meta_get(meta: Dict[str, Any], key: str) -> Any:
    for alias in _META_ALIASES.get(key, (key,)):
        if alias in meta:
            return meta[alias]
    return None


def _as_tensor_like(value: Any, like: torch.Tensor) -> Optional[torch.Tensor]:
    if value is None:
        return None
    if torch.is_tensor(value):
        return value.to(device=like.device, dtype=like.dtype if value.is_floating_point() else value.dtype)
    return torch.as_tensor(value, device=like.device)


def _num_tokens_to_valid_mask(num_tokens: Any, batch: int, padded_tokens: int, device: Any) -> torch.Tensor:
    if torch.is_tensor(num_tokens):
        counts = num_tokens.detach().to(device=device).flatten().long()
        if counts.numel() == 1:
            counts = counts.repeat(batch)
        elif counts.numel() != batch:
            counts = _repeat_to_batch(counts.view(-1, 1), batch).flatten().long()
    elif isinstance(num_tokens, (list, tuple)):
        counts = torch.tensor(num_tokens, device=device, dtype=torch.long).flatten()
        if counts.numel() == 1:
            counts = counts.repeat(batch)
        elif counts.numel() != batch:
            counts = _repeat_to_batch(counts.view(-1, 1), batch).flatten().long()
    else:
        counts = torch.full(
            (batch,),
            int(num_tokens) if num_tokens is not None else int(padded_tokens),
            device=device,
            dtype=torch.long,
        )
    counts = counts.clamp(min=0, max=int(padded_tokens))
    ar = torch.arange(int(padded_tokens), device=device).view(1, int(padded_tokens))
    return ar < counts.view(int(batch), 1)


def _conditioning_mask_from_source(source: Any, batch: int, padded_tokens: int, device: Any) -> Optional[torch.Tensor]:
    if source is None:
        return None
    if torch.is_tensor(source):
        x = source.detach().to(device=device)
        if x.ndim == 0:
            return _num_tokens_to_valid_mask(x, batch, padded_tokens, device)
        if x.ndim == 1:
            if x.numel() == batch and not x.is_floating_point():
                return _num_tokens_to_valid_mask(x, batch, padded_tokens, device)
            if x.numel() == 1:
                return _num_tokens_to_valid_mask(x, batch, padded_tokens, device)
            x = x.view(1, -1)
        if x.ndim > 2:
            x = x.reshape(x.shape[0], -1)
        if int(x.shape[0]) != int(batch):
            x = _repeat_to_batch(x, batch)
        if int(x.shape[1]) != int(padded_tokens):
            x = _pad_or_truncate_tokens(x, int(padded_tokens))
        if x.is_floating_point() and torch.any(x < 0):
            return (x >= 0).to(torch.bool)
        return x.to(torch.bool)
    try:
        return _num_tokens_to_valid_mask(int(source), batch, padded_tokens, device)
    except Exception:
        return None


def _target_valid_mask_from_c(c: Dict[str, Any], target_b: int, padded_tokens: int, device: Any) -> torch.Tensor:
    for key in ("attention_mask", "crossattn_mask", "c_crossattn_mask", "cap_mask", "mask"):
        mask = _conditioning_mask_from_source(c.get(key), target_b, padded_tokens, device)
        if mask is not None:
            return mask
    for key in ("num_tokens", "tokens_num", "n_tokens", "cap_num_tokens"):
        mask = _conditioning_mask_from_source(c.get(key), target_b, padded_tokens, device)
        if mask is not None:
            return mask
    return torch.ones((target_b, padded_tokens), device=device, dtype=torch.bool)


def _reference_valid_mask_from_conditioning(
    ref_cond: torch.Tensor,
    ref_meta: Dict[str, Any],
    target_b: int,
    padded_tokens: int,
    device: Any,
) -> torch.Tensor:
    for key in ("attention_mask", "crossattn_mask", "c_crossattn_mask", "cap_mask", "mask"):
        mask = _conditioning_mask_from_source(_meta_get(ref_meta, key), target_b, padded_tokens, device)
        if mask is not None:
            return mask
    for key in ("num_tokens", "tokens_num", "n_tokens", "cap_num_tokens"):
        mask = _conditioning_mask_from_source(_meta_get(ref_meta, key), target_b, padded_tokens, device)
        if mask is not None:
            return mask
    real_tokens = int(ref_cond.shape[1]) if ref_cond.ndim >= 2 else padded_tokens
    return _num_tokens_to_valid_mask(real_tokens, target_b, padded_tokens, device)


def _conditioning_counts_from_mask(mask: torch.Tensor) -> torch.Tensor:
    m = mask.to(torch.bool)
    if m.ndim == 1:
        m = m.view(1, -1)
    return m.long().sum(dim=1)


def _mask_to_additive(valid_mask: torch.Tensor, dtype: Any = torch.float32) -> torch.Tensor:
    valid = valid_mask.to(torch.bool)
    out = torch.zeros(valid.shape, device=valid.device, dtype=dtype)
    return out.masked_fill(~valid, -10000.0)


def _repeat_conditioning_tree(obj: Any, src: int, tgt: int) -> Any:
    if torch.is_tensor(obj):
        if obj.ndim > 0 and int(obj.shape[0]) == int(src):
            return _repeat_to_batch(obj, int(tgt))
        return obj
    if isinstance(obj, dict):
        return {k: v if k == "transformer_options" else _repeat_conditioning_tree(v, src, tgt) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_repeat_conditioning_tree(v, src, tgt) for v in obj]
    if isinstance(obj, tuple):
        return tuple(_repeat_conditioning_tree(v, src, tgt) for v in obj)
    return obj


def _coerce_ref_tensor_like_target(ref_value: torch.Tensor, target_value: torch.Tensor, target_b: int) -> torch.Tensor:
    ref = ref_value.to(device=target_value.device, dtype=target_value.dtype if ref_value.is_floating_point() else ref_value.dtype)
    if target_value.ndim >= 2 and ref.ndim == target_value.ndim - 1:
        ref = ref.unsqueeze(0)
    if ref.ndim > 0 and int(ref.shape[0]) != int(target_b):
        ref = _repeat_to_batch(ref, int(target_b))
    if target_value.ndim >= 2 and ref.ndim >= 2 and int(ref.shape[1]) != int(target_value.shape[1]):
        ref = _pad_or_truncate_tokens(ref, int(target_value.shape[1]))
    return ref


def _concat_batch_conditioning_value(
    key: str,
    value: Any,
    ref_cond: torch.Tensor,
    ref_meta: Dict[str, Any],
    target_b: int,
    forced_cap_mask: torch.Tensor,
) -> Any:
    if not torch.is_tensor(value):
        if key in _NUM_TOKEN_KEYS:
            target_counts = torch.as_tensor(value, device=forced_cap_mask.device, dtype=torch.long).flatten()
            if target_counts.numel() == 1:
                target_counts = target_counts.repeat(target_b)
            elif target_counts.numel() != target_b:
                target_counts = _repeat_to_batch(target_counts.view(-1, 1), target_b).flatten()
            ref_counts = _conditioning_counts_from_mask(forced_cap_mask[target_b : target_b * 2])
            return torch.cat([target_counts, ref_counts], dim=0)
        if key in _MASK_CONDITIONING_KEYS:
            return forced_cap_mask
        return _repeat_conditioning_tree(value, target_b, target_b * 2)

    if value.ndim == 0 or int(value.shape[0]) != int(target_b):
        return value

    ref_value: Optional[torch.Tensor] = None
    if key in _TEXT_CONDITIONING_KEYS or (
        value.ndim >= 3 and ref_cond.ndim >= 3 and int(value.shape[-1]) == int(ref_cond.shape[-1])
    ):
        ref_value = ref_cond
    elif key in _POOLED_CONDITIONING_KEYS:
        meta_value = _meta_get(ref_meta, key)
        if meta_value is not None:
            ref_value = _as_tensor_like(meta_value, value)
    elif key in _MASK_CONDITIONING_KEYS:
        ref_value = forced_cap_mask[target_b : target_b * 2].to(
            device=value.device,
            dtype=value.dtype if value.is_floating_point() else torch.bool,
        )
        if value.is_floating_point() and torch.any(value < 0):
            ref_value = _mask_to_additive(ref_value.to(torch.bool), dtype=value.dtype)
    elif key in _NUM_TOKEN_KEYS:
        ref_value = _conditioning_counts_from_mask(forced_cap_mask[target_b : target_b * 2]).to(
            device=value.device,
            dtype=value.dtype,
        )
    if ref_value is None:
        ref_value = value
    ref_value = _coerce_ref_tensor_like_target(ref_value, value, target_b)
    return torch.cat([value, ref_value], dim=0)


def _merge_reference_conditioning_into_c(
    c: Dict[str, Any],
    ref_conditioning: Any,
    target_b: int,
) -> Tuple[Dict[str, Any], torch.Tensor]:
    ref_cond, ref_meta = _extract_reference_conditioning(ref_conditioning)
    if ref_cond is None:
        raise RuntimeError("ref_conditioning must be connected and contain a valid CONDITIONING tensor.")

    target_text = None
    for key in ("c_crossattn", "crossattn", "context", "cap_feats", "cond", "encoder_hidden_states"):
        value = c.get(key)
        if torch.is_tensor(value) and value.ndim >= 3 and int(value.shape[0]) == int(target_b):
            target_text = value
            break
    if target_text is None:
        for key, value in c.items():
            if (
                key != "transformer_options"
                and torch.is_tensor(value)
                and value.ndim >= 3
                and int(value.shape[0]) == int(target_b)
                and ref_cond.ndim >= 3
                and int(value.shape[-1]) == int(ref_cond.shape[-1])
            ):
                target_text = value
                break
    if target_text is None:
        raise RuntimeError("Could not find the target text-conditioning tensor in model kwargs.")

    if ref_cond.ndim == target_text.ndim - 1:
        ref_cond = ref_cond.unsqueeze(0)
    if ref_cond.ndim < 3 or int(ref_cond.shape[-1]) != int(target_text.shape[-1]):
        raise RuntimeError(f"ref_conditioning shape {tuple(ref_cond.shape)} is incompatible with {tuple(target_text.shape)}.")

    padded_tokens = int(target_text.shape[1])
    device = target_text.device
    target_mask = _target_valid_mask_from_c(c, target_b, padded_tokens, device)
    ref_mask = _reference_valid_mask_from_conditioning(ref_cond, ref_meta, target_b, padded_tokens, device)
    forced_cap_mask = torch.cat([target_mask, ref_mask], dim=0).to(torch.bool)

    out: Dict[str, Any] = {}
    for key, value in c.items():
        if key == "transformer_options":
            out[key] = value
        else:
            out[key] = _concat_batch_conditioning_value(key, value, ref_cond, ref_meta, target_b, forced_cap_mask)
    return out, forced_cap_mask


def _merge_multi_reference_conditioning_into_c(
    c: Dict[str, Any],
    ref_conditionings: List[Any],
    target_b: int,
) -> Tuple[Dict[str, Any], torch.Tensor]:
    if not ref_conditionings:
        raise RuntimeError("At least one ref_conditioning is required.")

    ref_cond_metas: List[Tuple[torch.Tensor, Dict[str, Any]]] = []
    for ref_conditioning in ref_conditionings:
        ref_cond, ref_meta = _extract_reference_conditioning(ref_conditioning)
        if ref_cond is None:
            raise RuntimeError("Each ref_conditioning must contain a valid CONDITIONING tensor.")
        ref_cond_metas.append((ref_cond, ref_meta))

    target_text = None
    for key in ("c_crossattn", "crossattn", "context", "cap_feats", "cond", "encoder_hidden_states"):
        value = c.get(key)
        if torch.is_tensor(value) and value.ndim >= 3 and int(value.shape[0]) == int(target_b):
            target_text = value
            break
    if target_text is None:
        first_ref = ref_cond_metas[0][0]
        for key, value in c.items():
            if (
                key != "transformer_options"
                and torch.is_tensor(value)
                and value.ndim >= 3
                and int(value.shape[0]) == int(target_b)
                and first_ref.ndim >= 3
                and int(value.shape[-1]) == int(first_ref.shape[-1])
            ):
                target_text = value
                break
    if target_text is None:
        raise RuntimeError("Could not find the target text-conditioning tensor in model kwargs.")

    padded_tokens = int(target_text.shape[1])
    device = target_text.device
    target_mask = _target_valid_mask_from_c(c, target_b, padded_tokens, device)
    ref_conds: List[torch.Tensor] = []
    ref_masks: List[torch.Tensor] = []
    for ref_cond, ref_meta in ref_cond_metas:
        if ref_cond.ndim == target_text.ndim - 1:
            ref_cond = ref_cond.unsqueeze(0)
        if ref_cond.ndim < 3 or int(ref_cond.shape[-1]) != int(target_text.shape[-1]):
            raise RuntimeError(f"ref_conditioning shape {tuple(ref_cond.shape)} is incompatible with {tuple(target_text.shape)}.")
        ref_conds.append(ref_cond)
        ref_masks.append(_reference_valid_mask_from_conditioning(ref_cond, ref_meta, target_b, padded_tokens, device))

    forced_cap_mask = torch.cat([target_mask] + ref_masks, dim=0).to(torch.bool)

    out: Dict[str, Any] = {}
    for key, value in c.items():
        if key == "transformer_options":
            out[key] = value
            continue
        if not torch.is_tensor(value):
            if key in _NUM_TOKEN_KEYS:
                target_counts = torch.as_tensor(value, device=forced_cap_mask.device, dtype=torch.long).flatten()
                if target_counts.numel() == 1:
                    target_counts = target_counts.repeat(target_b)
                elif target_counts.numel() != target_b:
                    target_counts = _repeat_to_batch(target_counts.view(-1, 1), target_b).flatten()
                ref_counts = [_conditioning_counts_from_mask(m) for m in ref_masks]
                out[key] = torch.cat([target_counts] + ref_counts, dim=0)
            elif key in _MASK_CONDITIONING_KEYS:
                out[key] = forced_cap_mask
            else:
                out[key] = _repeat_conditioning_tree(value, target_b, target_b * (1 + len(ref_conds)))
            continue

        if value.ndim == 0 or int(value.shape[0]) != int(target_b):
            out[key] = value
            continue

        values = [value]
        if key in _TEXT_CONDITIONING_KEYS or (
            value.ndim >= 3 and ref_conds[0].ndim >= 3 and int(value.shape[-1]) == int(ref_conds[0].shape[-1])
        ):
            values.extend(_coerce_ref_tensor_like_target(ref_cond, value, target_b) for ref_cond in ref_conds)
        elif key in _MASK_CONDITIONING_KEYS:
            values.extend(
                m.to(device=value.device, dtype=value.dtype if value.is_floating_point() else torch.bool)
                for m in ref_masks
            )
        elif key in _NUM_TOKEN_KEYS:
            values.extend(_conditioning_counts_from_mask(m).to(device=value.device, dtype=value.dtype) for m in ref_masks)
        else:
            values.extend(value for _ in ref_conds)
        out[key] = torch.cat(values, dim=0)
    return out, forced_cap_mask


def _slice_conditioning_batch(obj: Any, start: int, end: int) -> Any:
    if torch.is_tensor(obj):
        if obj.ndim > 0 and int(obj.shape[0]) >= int(end):
            return obj[int(start) : int(end)]
        return obj
    if isinstance(obj, dict):
        return {k: (v if k == "transformer_options" else _slice_conditioning_batch(v, start, end)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_slice_conditioning_batch(v, start, end) for v in obj]
    if isinstance(obj, tuple):
        return tuple(_slice_conditioning_batch(v, start, end) for v in obj)
    return obj


def _clone_conditioning_for_rf(c: Dict[str, Any]) -> Dict[str, Any]:
    out = c.copy()
    to = out.get("transformer_options", {})
    if isinstance(to, dict):
        to = to.copy()
        to.pop(_CONFIG_KEY, None)
        out["transformer_options"] = to
    else:
        out["transformer_options"] = {}
    return out


def _build_rf_conditioning_kwargs(c: Dict[str, Any], ref_conditioning: Any, target_b: int) -> Dict[str, Any]:
    merged, _mask = _merge_reference_conditioning_into_c(c, ref_conditioning, target_b)
    ref_only = _slice_conditioning_batch(merged, target_b, target_b * 2)
    return _clone_conditioning_for_rf(ref_only)


def _rf_comfy_convert_tensor(extra: Any, dtype: Any, device: Any) -> Any:
    if hasattr(extra, "dtype"):
        if extra.dtype != torch.int and extra.dtype != torch.long:
            extra = comfy.model_management.cast_to_device(extra, device, dtype)
        else:
            extra = comfy.model_management.cast_to_device(extra, device, None)
    return extra


def _raw_transformer_velocity(
    apply_model: Callable,
    x: torch.Tensor,
    t: torch.Tensor,
    c_concat: Optional[torch.Tensor] = None,
    c_crossattn: Optional[torch.Tensor] = None,
    control: Any = None,
    transformer_options: Optional[Dict[str, Any]] = None,
    **kwargs: Any,
) -> torch.Tensor:
    base_model = getattr(apply_model, "__self__", None)
    if base_model is None:
        raise RuntimeError("Krea2 Style Transfer requires a bound Comfy BaseModel.apply_model.")
    if not hasattr(base_model, "diffusion_model") or not hasattr(base_model, "model_sampling"):
        raise RuntimeError("Krea2 Style Transfer requires a FLOW/FLUX Comfy BaseModel.")
    if not torch.is_tensor(x) or not torch.is_tensor(t):
        raise RuntimeError("Krea2 Style Transfer RF path received invalid tensor input.")

    sigma = t
    xc = base_model.model_sampling.calculate_input(sigma, x)
    if c_concat is not None:
        xc = torch.cat([xc] + [comfy.model_management.cast_to_device(c_concat, xc.device, xc.dtype)], dim=1)

    context = c_crossattn
    dtype = base_model.get_dtype_inference()
    xc = xc.to(dtype)
    device = xc.device
    t_model = base_model.model_sampling.timestep(t).float()
    if context is not None:
        context = comfy.model_management.cast_to_device(context, device, dtype)

    extra_conds: Dict[str, Any] = {}
    for name, extra in kwargs.items():
        if hasattr(extra, "dtype"):
            extra = _rf_comfy_convert_tensor(extra, dtype, device)
        elif isinstance(extra, list):
            extra = [_rf_comfy_convert_tensor(item, dtype, device) for item in extra]
        extra_conds[name] = extra

    t_model = base_model.process_timestep(t_model, x=x, **extra_conds)
    if "latent_shapes" in extra_conds:
        xc = comfy.utils.unpack_latents(xc, extra_conds.pop("latent_shapes"))

    transformer_options = (transformer_options or {}).copy()
    transformer_options["prefetch_dynamic_vbars"] = (
        base_model.current_patcher is not None and base_model.current_patcher.is_dynamic()
    )

    model_output = base_model.diffusion_model(
        xc,
        t_model,
        context=context,
        control=control,
        transformer_options=transformer_options,
        **extra_conds,
    )
    if not torch.is_tensor(model_output):
        if isinstance(model_output, (list, tuple)):
            model_output, _ = comfy.utils.pack_latents(model_output)
    if not torch.is_tensor(model_output):
        raise RuntimeError("Krea2 Style Transfer expected diffusion_model to return a tensor.")
    return model_output.to(dtype=xc.dtype)


def _model_inference_dtype_from_apply_model(apply_model: Callable, fallback: torch.dtype) -> torch.dtype:
    base_model = getattr(apply_model, "__self__", None)
    if base_model is not None and hasattr(base_model, "get_dtype_inference"):
        try:
            dtype = base_model.get_dtype_inference()
            if dtype in (torch.float16, torch.bfloat16, torch.float32):
                return dtype
        except Exception:
            pass
    return fallback


def _make_raw_velocity_apply_model_fn(apply_model: Callable) -> Callable:
    def raw_velocity_apply_model(
        x: torch.Tensor,
        t: torch.Tensor,
        c_concat: Optional[torch.Tensor] = None,
        c_crossattn: Optional[torch.Tensor] = None,
        control: Any = None,
        transformer_options: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> torch.Tensor:
        return _raw_transformer_velocity(
            apply_model,
            x,
            t,
            c_concat=c_concat,
            c_crossattn=c_crossattn,
            control=control,
            transformer_options=transformer_options,
            **kwargs,
        )

    return raw_velocity_apply_model


def _sigma_from_timestep(timestep: torch.Tensor) -> float:
    if not torch.is_tensor(timestep):
        raise RuntimeError("Sigma conversion failed: timestep is not a tensor.")
    value = float(timestep.detach().float().mean().item())
    if not math.isfinite(value):
        raise RuntimeError(f"Sigma conversion failed: timestep is not finite: {value!r}.")
    if 0.0 <= value <= 1.0:
        return max(0.0, min(1.0, value))
    if 1.0 < value <= 1000.0:
        return max(0.0, min(1.0, value / 1000.0))
    raise RuntimeError(f"Sigma conversion failed: unsupported timestep value {value!r}.")


def _sigma_to_progress(sigma: float, sampler_sigmas: List[float]) -> float:
    active = [max(0.0, min(1.0, float(s))) for s in (sampler_sigmas or [])]
    while active and active[-1] <= 1e-8:
        active.pop()
    if len(active) < 2:
        return 0.0
    idx = min(range(len(active)), key=lambda i: abs(active[i] - float(sigma)))
    return max(0.0, min(1.0, idx / max(1, len(active) - 1)))


def _flowturbo_pc_internal_sigmas(sigmas: List[float]) -> List[float]:
    clean: List[float] = []
    for sigma in sigmas or []:
        sf = max(0.0, min(1.0, float(sigma)))
        if not clean or abs(sf - clean[-1]) > 1e-8:
            clean.append(sf)
    clean = sorted(clean)
    if len(clean) <= 1:
        return clean
    grid: List[float] = [clean[0]]
    for i in range(len(clean) - 1):
        a, b = clean[i], clean[i + 1]
        if b - a > 1e-8:
            mid = 0.5 * (a + b)
            if mid - grid[-1] > 1e-8 and b - mid > 1e-8:
                grid.append(mid)
        grid.append(b)
    out: List[float] = []
    for sigma in grid:
        if not out or abs(float(sigma) - out[-1]) > 1e-8:
            out.append(float(sigma))
    return out


def _linear_target(ref_clean: torch.Tensor, eps: torch.Tensor, sigma: float) -> torch.Tensor:
    sigma = max(0.0, min(1.0, float(sigma)))
    return (1.0 - sigma) * ref_clean + sigma * eps


def _active_hook_state(patcher: Any) -> Tuple[bool, Optional[Tuple[Any, ...]]]:
    """Return whether active hooks are dynamic and a stable static-hook token."""
    current_hooks = getattr(patcher, "current_hooks", None)
    if current_hooks is None:
        return False, ("no-hooks",)
    hook_list = getattr(current_hooks, "hooks", None)
    if hook_list is None:
        return True, None
    try:
        hooks = list(hook_list)
    except Exception:
        return True, None
    if not hooks:
        return False, ("no-hooks",)

    token: List[Any] = []
    for hook in hooks:
        keyframe_group = getattr(hook, "hook_keyframe", None)
        keyframes = getattr(keyframe_group, "keyframes", None)
        if keyframes is None:
            return True, None
        strengths: List[float] = []
        try:
            for keyframe in keyframes:
                strength = getattr(keyframe, "strength", None)
                if isinstance(strength, bool) or not isinstance(strength, (int, float)):
                    return True, None
                strengths.append(float(strength))
        except Exception:
            return True, None
        if len({value.hex() for value in strengths}) > 1:
            return True, None

        current_strength = getattr(hook, "strength", None)
        if isinstance(current_strength, bool) or not isinstance(current_strength, (int, float)):
            return True, None
        hook_ref = getattr(hook, "hook_ref", hook)
        token.append(
            (
                type(hook).__module__,
                type(hook).__qualname__,
                id(hook_ref),
                tuple(value.hex() for value in strengths),
                float(current_strength).hex(),
            )
        )
    return False, tuple(token)


def _has_dynamic_weight_hooks(apply_model: Callable) -> bool:
    base_model = getattr(apply_model, "__self__", None)
    patcher = getattr(base_model, "current_patcher", None)
    if patcher is None:
        return False
    dynamic, _token = _active_hook_state(patcher)
    return dynamic


def _model_identity(
    apply_model: Callable,
    include_active_static_hooks: bool = False,
) -> Tuple[Optional[bytes], Optional[Tuple[Tuple[int, Any], ...]]]:
    base_model = getattr(apply_model, "__self__", None)
    if base_model is None:
        return None, None
    diffusion_model = getattr(base_model, "diffusion_model", None)
    sampling = getattr(base_model, "model_sampling", None)
    if diffusion_model is None or sampling is None:
        return None, None
    patcher = getattr(base_model, "current_patcher", None)
    if patcher is None:
        return None, None
    hook_dynamic, hook_token = _active_hook_state(patcher)
    current_hooks = getattr(patcher, "current_hooks", None)
    if current_hooks is not None:
        if not include_active_static_hooks or hook_dynamic or hook_token is None:
            return None, None
    patches_uuid = getattr(patcher, "patches_uuid", None)
    patcher_model = getattr(patcher, "model", None)
    if not patches_uuid or patcher_model is None:
        return None, None
    # A fresh ModelPatcher clone shares patches_uuid and the same underlying model;
    # only stable objects may participate in guards or the key.
    guards = _guard_objects([base_model, diffusion_model, sampling, patcher_model])
    if guards is None:
        return None, None
    parts = (
        type(base_model).__module__,
        type(base_model).__qualname__,
        str(id(base_model)),
        type(diffusion_model).__module__,
        type(diffusion_model).__qualname__,
        str(id(diffusion_model)),
        type(sampling).__module__,
        type(sampling).__qualname__,
        str(id(sampling)),
        type(patcher_model).__module__,
        type(patcher_model).__qualname__,
        str(id(patcher_model)),
        str(patches_uuid),
        str(getattr(base_model, "current_weight_patches_uuid", None)),
        repr(hook_token),
    )
    return "|".join(parts).encode("utf-8"), guards


def _stable_rf_kwargs(rf_kwargs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Normalize only ComfyUI run metadata; bypass custom patch/callback state."""
    stable: Dict[str, Any] = {}
    for key, value in rf_kwargs.items():
        if key == "transformer_options" and isinstance(value, dict):
            # Custom patches may read uuids/sigmas or retain mutable callback
            # state. Never reuse a cross-run RF schedule in that case.
            if value.get("callbacks") or value.get("patches"):
                return None
            stable[key] = {
                name: item for name, item in value.items() if name not in _RF_RUN_IDENTIFIER_KEYS
            }
        else:
            stable[key] = value
    return stable


def _rf_run_schedule_key(
    apply_model: Callable,
    input_shape: Tuple[int, ...],
    input_dtype: torch.dtype,
    sampler_sigmas: List[float],
    device: Any,
    sample_sigmas_token: Any,
    hook_token: Any,
    context_token: Any = None,
    run_generation: int = 0,
) -> Tuple[Any, ...]:
    identity, _guards = _model_identity(apply_model, include_active_static_hooks=True)
    if identity is None:
        base_model = getattr(apply_model, "__self__", None)
        identity = f"untrusted-model:{id(base_model)}".encode("ascii")
    return (
        int(run_generation),
        identity,
        tuple(int(value) for value in input_shape),
        str(input_dtype),
        tuple(float(value).hex() for value in sampler_sigmas),
        str(device),
        repr(sample_sigmas_token),
        repr(hook_token),
        repr(context_token),
    )


def _runtime_context_token(value: Any) -> Any:
    """Build an identity token for local-only state that cannot be content-hashed."""
    if value is None or isinstance(value, (bool, int, float, str, bytes)):
        return (type(value).__name__, value)
    if callable(value):
        return ("callable", id(value))
    if torch.is_tensor(value):
        try:
            data_ptr = int(value.data_ptr())
        except Exception:
            data_ptr = None
        try:
            version = int(value._version)
        except Exception:
            version = None
        return (
            "tensor",
            str(value.dtype),
            tuple(value.shape),
            str(value.device),
            data_ptr,
            version,
        )
    if isinstance(value, dict):
        return tuple(
            (repr(key), _runtime_context_token(item))
            for key, item in sorted(value.items(), key=lambda pair: repr(pair[0]))
        )
    if isinstance(value, (list, tuple)):
        return tuple(_runtime_context_token(item) for item in value)
    return (type(value).__module__, type(value).__qualname__, id(value))


def _rf_kwargs_run_context_token(rf_kwargs: Dict[str, Any]) -> Any:
    """Create a stable run-local token across ComfyUI's per-step cond_cat calls."""
    stable: Dict[str, Any] = {}
    per_call_metadata = {"uuids", "cond_or_uncond", "sigmas", "sample_sigmas"}
    for key, value in rf_kwargs.items():
        if key == "transformer_options" and isinstance(value, dict):
            stable[key] = {
                name: item for name, item in value.items() if name not in per_call_metadata
            }
        else:
            stable[key] = value
    return _run_context_value_token(stable)


def _run_context_value_token(value: Any) -> Any:
    """Tokenize run-local values without relying on freshly concatenated tensor addresses."""
    if torch.is_tensor(value):
        try:
            version = int(value._version)
        except Exception:
            version = None
        return (
            "tensor",
            str(value.dtype),
            tuple(int(size) for size in value.shape),
            str(value.device),
            version,
        )
    if callable(value):
        return ("callable", id(value))
    if isinstance(value, dict):
        return tuple(
            (repr(key), _run_context_value_token(item))
            for key, item in sorted(value.items(), key=lambda pair: repr(pair[0]))
        )
    if isinstance(value, (list, tuple)):
        return tuple(_run_context_value_token(item) for item in value)
    return _runtime_context_token(value)


def _rf_condition_branch_token(transformer_options: Any) -> Any:
    """Use ComfyUI's stable per-condition UUIDs and CFG branch IDs within a run."""
    if not isinstance(transformer_options, dict):
        return (None, None)

    def marker(value: Any) -> Any:
        if value is None or isinstance(value, (bool, int, float, str, bytes)):
            return (type(value).__name__, value)
        if isinstance(value, (list, tuple)):
            return tuple(marker(item) for item in value)
        if isinstance(value, dict):
            return tuple(
                (repr(key), marker(item))
                for key, item in sorted(value.items(), key=lambda pair: repr(pair[0]))
            )
        return (type(value).__module__, type(value).__qualname__, str(value))

    return (
        marker(transformer_options.get("uuids")),
        marker(transformer_options.get("cond_or_uncond")),
    )


def _rf_run_source_context_token(
    ref_clean: torch.Tensor,
    c: Dict[str, Any],
    ref_conditioning: Any,
) -> Any:
    """Tokenize stable sampler inputs before building temporary merged tensors."""
    transformer_options = c.get("transformer_options") if isinstance(c, dict) else None
    return (
        _runtime_context_token(ref_clean),
        _rf_kwargs_run_context_token(c),
        _rf_condition_branch_token(transformer_options),
        _runtime_context_token(ref_conditioning),
    )


def _rf_kwargs_has_thread_local_context(rf_kwargs: Dict[str, Any]) -> bool:
    transformer_options = rf_kwargs.get("transformer_options")
    if not isinstance(transformer_options, dict):
        return False
    return bool(transformer_options.get("callbacks") or transformer_options.get("patches"))


def _get_or_build_run_scoped_cache(
    state: Dict[str, Any],
    cache_name: str,
    build_locks_name: str,
    key: Any,
    build_fn: Callable[[], Any],
    max_entries: int,
    run_generation: Optional[int] = None,
) -> Tuple[Any, bool]:
    registry_lock = state.setdefault("_schedule_lock", threading.RLock())
    with registry_lock:
        cache = state.setdefault(cache_name, OrderedDict())
        generation = int(state.get("run_generation", 0))
        expected_generation = generation if run_generation is None else int(run_generation)
        cached = cache.get(key) if generation == expected_generation else None
        if cached is not None:
            cache.move_to_end(key)
            return cached, False
        build_locks = state.setdefault(build_locks_name, {})
        entry = build_locks.get(key)
        if entry is None:
            entry = {"lock": threading.Lock(), "users": 0}
            build_locks[key] = entry
        entry["users"] += 1

    try:
        # Serialize identical keys, but do not hold the shared registry lock
        # while running model forwards. Different devices/contexts can build
        # their RF schedules concurrently.
        with entry["lock"]:
            with registry_lock:
                current_generation = int(state.get("run_generation", 0))
                cached = cache.get(key) if current_generation == expected_generation else None
                if cached is not None:
                    cache.move_to_end(key)
                    return cached, False

            built = build_fn()
            with registry_lock:
                # Do not let an old sampler refill or evict entries in a newer
                # scope if its long RF build finishes after that scope starts.
                if int(state.get("run_generation", 0)) == expected_generation:
                    cache[key] = built
                    while len(cache) > max(1, int(max_entries)):
                        cache.popitem(last=False)
            return built, True
    finally:
        with registry_lock:
            entry["users"] -= 1
            if entry["users"] <= 0 and build_locks.get(key) is entry:
                build_locks.pop(key, None)


def _get_or_build_run_schedule(
    state: Dict[str, Any],
    key: Any,
    build_fn: Callable[[], Any],
    max_entries: int = 4,
    run_generation: Optional[int] = None,
) -> Tuple[Any, bool]:
    return _get_or_build_run_scoped_cache(
        state,
        "run_schedules",
        "_schedule_build_locks",
        key,
        build_fn,
        max_entries,
        run_generation,
    )


def _get_or_build_run_context_key(
    state: Dict[str, Any],
    key: Any,
    build_fn: Callable[[], Any],
    max_entries: int = 8,
    run_generation: Optional[int] = None,
) -> Tuple[Any, bool]:
    return _get_or_build_run_scoped_cache(
        state,
        "rf_context_keys",
        "_rf_context_build_locks",
        key,
        build_fn,
        max_entries,
        run_generation,
    )


def _begin_run_schedule_scope(state: Dict[str, Any]) -> int:
    """Start a sampler-local cache scope so mutable kwargs cannot leak across runs."""
    lock = state.setdefault("_schedule_lock", threading.RLock())
    with lock:
        generation = int(state.get("run_generation", 0)) + 1
        state["run_generation"] = generation
        state.setdefault("run_schedules", OrderedDict()).clear()
        state.setdefault("rf_context_keys", OrderedDict()).clear()
        return generation


def _rf_cache_key(
    apply_model: Callable,
    ref_for_build: torch.Tensor,
    rf_kwargs: Dict[str, Any],
    sampler_sigmas: List[float],
    target_b: int,
    rf_dtype: torch.dtype,
    device: Any,
    gamma: float,
    seed: int,
    rf_mode: str,
    include_active_static_hooks: bool = False,
) -> Tuple[Optional[str], Optional[Tuple[Tuple[int, Any], ...]]]:
    identity, guards = _model_identity(apply_model, include_active_static_hooks)
    if identity is None or guards is None:
        return None, None
    stable_kwargs = _stable_rf_kwargs(rf_kwargs)
    if stable_kwargs is None:
        return None, None
    guard_objects: List[Any] = []
    digest = hashlib.sha256()
    digest.update(b"krea2-rf-schedule-v1")
    digest.update(identity)
    if not _update_digest(digest, ref_for_build, guard_objects):
        return None, None
    if not _update_digest(digest, stable_kwargs, guard_objects):
        return None, None
    digest.update(repr([float(value).hex() for value in sampler_sigmas]).encode("ascii"))
    digest.update(str(int(target_b)).encode("ascii"))
    digest.update(str(rf_dtype).encode("ascii"))
    digest.update(str(device).encode("ascii"))
    digest.update(repr(float(gamma)).encode("ascii"))
    digest.update(str(int(seed)).encode("ascii"))
    digest.update(str(rf_mode).encode("utf-8"))
    if guard_objects:
        extra = _guard_objects(guard_objects)
        if extra is None:
            return None, None
        guards = guards + extra
    return digest.hexdigest(), guards


def _prepare_rf_cache(
    apply_model: Callable,
    ref_for_build: torch.Tensor,
    rf_kwargs: Dict[str, Any],
    sampler_sigmas: List[float],
    target_b: int,
    rf_dtype: torch.dtype,
    device: Any,
    gamma: float,
    seed: int,
    rf_mode: str,
    build_fn: Optional[Callable[[torch.Tensor, List[float]], Tuple[Dict[float, torch.Tensor], Any, List[float]]]] = None,
    cache_identity: Optional[Tuple[Optional[str], Optional[Tuple[Tuple[int, Any], ...]]]] = None,
) -> Tuple[Dict[float, torch.Tensor], List[float], bool, float]:
    started = time.perf_counter()
    if cache_identity is None:
        key, guards = _rf_cache_key(
            apply_model, ref_for_build, rf_kwargs, sampler_sigmas, target_b,
            rf_dtype, device, gamma, seed, rf_mode,
        )
    else:
        key, guards = cache_identity
    if key is not None:
        entry = _RF_CACHE.get(key)
        if entry is not None:
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            moved = {}
            for sigma, tensor in entry["rf"].items():
                target = tensor.to(device=device, dtype=rf_dtype)
                moved[float(sigma)] = target if target is not tensor else tensor.clone()
            _log_timing(
                "RF 缓存命中",
                elapsed_ms=elapsed_ms,
                bytes=_tensor_nbytes(entry["rf"]),
                sigmas=len(entry["sigmas"]),
                device=str(device),
                entries=len(_RF_CACHE),
            )
            return moved, list(entry["sigmas"]), True, elapsed_ms

    if build_fn is None:
        velocity = _make_raw_velocity_apply_model_fn(apply_model)

        def build_fn(reference: torch.Tensor, sigmas: List[float]):
            return _build_rf_cache(
                reference, sigmas, velocity, rf_kwargs,
                gamma=float(gamma), seed=int(seed), rf_mode=str(rf_mode),
            )

    cache, _eps, sorted_sigmas = build_fn(ref_for_build, list(sampler_sigmas))
    cpu_cache = {
        float(sigma): tensor.detach().to(device="cpu").clone()
        for sigma, tensor in cache.items()
    }
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    stored = False
    if key is not None:
        stored = _RF_CACHE.put(
            key,
            {"rf": cpu_cache, "sigmas": list(sorted_sigmas)},
            _tensor_nbytes(cpu_cache),
            guards,
        )
    _log_timing(
        "RF 缓存未命中",
        elapsed_ms=elapsed_ms,
        bytes=_tensor_nbytes(cpu_cache),
        stored=stored,
        entries=len(_RF_CACHE),
    )
    return cache, list(sorted_sigmas), False, elapsed_ms


def _build_rf_cache(
    ref_clean: torch.Tensor,
    sampler_sigmas: List[float],
    apply_model_fn: Callable,
    base_model_kwargs: Dict[str, Any],
    gamma: float,
    seed: int,
    rf_mode: str,
) -> Tuple[Dict[float, torch.Tensor], torch.Tensor, List[float]]:
    sigmas: List[float] = [0.0]
    for sigma in sampler_sigmas or []:
        sf = max(0.0, min(1.0, float(sigma)))
        if all(abs(sf - existing) > 1e-6 for existing in sigmas):
            sigmas.append(sf)
    sigmas = sorted(sigmas)
    if len(sigmas) <= 1:
        raise RuntimeError("RF schedule did not contain usable non-zero sigmas.")

    rng = torch.Generator(device=ref_clean.device)
    rng.manual_seed(int(seed))
    eps = torch.randn(ref_clean.shape, device=ref_clean.device, dtype=ref_clean.dtype, generator=rng)

    mode = str(rf_mode or "flowturbo_pc")
    if mode not in {"flowturbo_pc", "rf_gamma", "rf_gamma_rk2", "linear"}:
        mode = "flowturbo_pc"

    z = ref_clean.clone()
    cache: Dict[float, torch.Tensor] = {0.0: z.detach().clone()}
    device = ref_clean.device

    def call_velocity(z_in: torch.Tensor, sigma_value: float) -> torch.Tensor:
        t = torch.full((z_in.shape[0],), float(sigma_value), device=device, dtype=torch.float32)
        with torch.no_grad():
            return apply_model_fn(z_in, t, **base_model_kwargs).to(dtype=z_in.dtype)

    if mode == "linear":
        for sigma in sigmas[1:]:
            z = _linear_target(ref_clean, eps, sigma)
            cache[round(float(sigma), 6)] = z.detach().clone()
        return cache, eps, sigmas

    if mode == "flowturbo_pc":
        internal = _flowturbo_pc_internal_sigmas(sigmas)
        original_keys = {round(float(v), 6) for v in sigmas}
        v_start = call_velocity(z, internal[0])
        for step in range(1, len(internal)):
            sigma_prev = float(internal[step - 1])
            sigma_cur = float(internal[step])
            delta = sigma_cur - sigma_prev
            z_pred = z + delta * v_start
            v_end = call_velocity(z_pred, sigma_cur)
            z_model = z + 0.5 * delta * (v_start + v_end)
            z_prior = _linear_target(ref_clean, eps, sigma_cur)
            z = float(gamma) * z_model + (1.0 - float(gamma)) * z_prior
            v_start = v_end.detach()
            key = round(sigma_cur, 6)
            if key in original_keys:
                cache[key] = z.detach().clone()
        missing = [round(float(v), 6) for v in sigmas if round(float(v), 6) not in cache]
        if missing:
            raise RuntimeError(f"RF cache missing sampler endpoints: {missing}.")
        return cache, eps, sigmas

    prev = 0.0
    for sigma_cur in sigmas[1:]:
        sigma_prev = float(prev)
        sigma_cur = float(sigma_cur)
        delta = sigma_cur - sigma_prev
        v_model = call_velocity(z, sigma_prev)
        denom = max(1.0 - sigma_prev, 1e-7)
        v_prior = (eps - z) / denom
        if mode == "rf_gamma_rk2":
            v1 = float(gamma) * v_model + (1.0 - float(gamma)) * v_prior
            z_mid = z + 0.5 * delta * v1
            sigma_mid = sigma_prev + 0.5 * delta
            v_mid = call_velocity(z_mid, sigma_mid)
            denom_mid = max(1.0 - sigma_mid, 1e-7)
            v_prior_mid = (eps - z_mid) / denom_mid
            v_total = float(gamma) * v_mid + (1.0 - float(gamma)) * v_prior_mid
        else:
            v_total = float(gamma) * v_model + (1.0 - float(gamma)) * v_prior
        z = z + delta * v_total
        prev = sigma_cur
        cache[round(float(sigma_cur), 6)] = z.detach().clone()
    return cache, eps, sigmas


def _rf_cache_lookup(cache: Dict[float, torch.Tensor], sigma: float) -> Tuple[Optional[torch.Tensor], float]:
    key = round(float(sigma), 6)
    if key in cache:
        return cache[key], key
    if not cache:
        return None, key
    nearest = min(cache.keys(), key=lambda k: abs(float(k) - key))
    return cache.get(nearest), float(nearest)


class Krea2StyleReference:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": ("VAE",),
                "target_latent": ("LATENT",),
                "reference_image": ("IMAGE",),
                "fit": (["crop", "contain", "stretch"], {"default": "crop"}),
                "upscale_method": (
                    ["lanczos", "bicubic", "bilinear", "nearest-exact", "area"],
                    {"default": "lanczos", "advanced": True},
                ),
            }
        }

    RETURN_TYPES = ("LATENT", "IMAGE", "STRING")
    RETURN_NAMES = ("reference_latent", "reference_preview", "debug")
    FUNCTION = "build"
    CATEGORY = _CATEGORY
    DESCRIPTION = "Prepare a style reference image for local Krea2 style transfer."

    def build(self, vae, target_latent, reference_image, fit, upscale_method):
        width, height = _latent_width_height(target_latent)
        if reference_image.shape[0] > 1:
            reference_image = reference_image[:1]
        preview = _fit_image_to_box(reference_image[:, :, :, :3], width, height, fit, upscale_method)
        started = time.perf_counter()
        key, guards = _reference_latent_key(vae, preview, width, height, fit, upscale_method)
        samples = _REFERENCE_LATENT_CACHE.get(key) if key is not None else None
        cached = samples is not None
        if cached:
            target_device = getattr(vae, "device", None) or preview.device
            try:
                samples = samples.to(device=target_device).clone()
            except Exception:
                cached = False
                samples = None
        if samples is None:
            reference_latent = _vae_encode_image(vae, preview)
            samples = reference_latent["samples"]
            cpu_samples = samples.detach().to(device="cpu").clone()
            if key is not None:
                _REFERENCE_LATENT_CACHE.put(key, cpu_samples, _tensor_nbytes(cpu_samples), guards)
        _log_timing(
            "参考图 VAE 编码",
            cached=cached,
            elapsed_ms=(time.perf_counter() - started) * 1000.0,
            bytes=_tensor_nbytes(samples),
            size=f"{int(width)}x{int(height)}",
        )
        reference_latent = {"samples": samples}
        debug = f"single_reference=true; size={width}x{height}; fit={fit}; method={upscale_method}"
        return reference_latent, preview, debug






class Krea2StyleTransfer:
    _RECOMMENDED = {
        "style_strength": 1.0,
        "value_adain_strength": 0.65,
        "ref_value_mix": 1.0,
        "ref_k_strength": 1.06,
        "rf_mode": "flowturbo_pc",
        "gamma": 0.5,
        "beta": 2.5,
        "high_scale_start": 1.04,
        "high_scale_end": 0.0,
        "low_scale_start": 1.0,
        "low_scale_end": 1.10,
        "adain_strength": 0.85,
        "blocks": "7-27",
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "reference_latent": ("LATENT",),
                "ref_conditioning": ("CONDITIONING",),
                "mode": (["recommended", "custom"], {"default": "recommended"}),
                "style_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 2.0,
                        "step": 0.05,
                        "advanced": True,
                        "tooltip": "Overall style mix. 0 disables the reference path.",
                    },
                ),
                "value_adain_strength": (
                    "FLOAT",
                    {
                        "default": 0.65,
                        "min": 0.0,
                        "max": 1.5,
                        "step": 0.05,
                        "advanced": True,
                        "tooltip": "How much reference value statistics are applied to the target value path.",
                    },
                ),
                "ref_value_mix": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "advanced": True,
                        "tooltip": "How much raw reference value signal is kept. Higher values usually preserve style material better.",
                    },
                ),
                "ref_k_strength": (
                    "FLOAT",
                    {
                        "default": 1.06,
                        "min": 0.0,
                        "max": 5.0,
                        "step": 0.01,
                        "advanced": True,
                        "tooltip": "Direct multiplier for reference K. Higher values make the target attend to the reference branch more strongly.",
                    },
                ),
                "rf_mode": (
                    ["flowturbo_pc", "rf_gamma", "rf_gamma_rk2", "linear"],
                    {"default": "flowturbo_pc", "advanced": True},
                ),
                "gamma": (
                    "FLOAT",
                    {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "advanced": True},
                ),
                "beta": (
                    "FLOAT",
                    {"default": 2.5, "min": 0.01, "max": 20.0, "step": 0.01, "advanced": True},
                ),
                "high_scale_start": (
                    "FLOAT",
                    {"default": 1.04, "min": -4.0, "max": 8.0, "step": 0.01, "advanced": True},
                ),
                "high_scale_end": (
                    "FLOAT",
                    {"default": 0.0, "min": -4.0, "max": 8.0, "step": 0.01, "advanced": True},
                ),
                "low_scale_start": (
                    "FLOAT",
                    {"default": 1.0, "min": -4.0, "max": 8.0, "step": 0.01, "advanced": True},
                ),
                "low_scale_end": (
                    "FLOAT",
                    {"default": 1.10, "min": -4.0, "max": 8.0, "step": 0.01, "advanced": True},
                ),
                "adain_strength": (
                    "FLOAT",
                    {"default": 0.85, "min": 0.0, "max": 1.0, "step": 0.01, "advanced": True},
                ),
                "blocks": (
                    "STRING",
                    {"default": "7-27", "advanced": True},
                ),
            }
        }

    RETURN_TYPES = ("MODEL", "LATENT", "STRING")
    RETURN_NAMES = ("model", "rf_reference", "debug")
    FUNCTION = "patch"
    CATEGORY = _CATEGORY
    DESCRIPTION = "Experimental single-image style transfer that keeps the old reference K path but controls the reference V/value path."

    def patch(
        self,
        model,
        reference_latent,
        ref_conditioning,
        mode,
        style_strength,
        value_adain_strength,
        ref_value_mix,
        ref_k_strength,
        rf_mode,
        gamma,
        beta,
        high_scale_start,
        high_scale_end,
        low_scale_start,
        low_scale_end,
        adain_strength,
        blocks,
    ):
        if not isinstance(reference_latent, dict) or "samples" not in reference_latent:
            raise ValueError("reference_latent must be a LATENT dict with samples.")
        ref_clean = _latent_samples(reference_latent, "reference_latent").detach().clone()
        ref_clean = model.model.process_latent_in(ref_clean)

        if str(mode) == "recommended":
            preset = dict(self._RECOMMENDED)
            style_strength = preset["style_strength"]
            value_adain_strength = preset["value_adain_strength"]
            ref_value_mix = preset["ref_value_mix"]
            ref_k_strength = preset["ref_k_strength"]
            rf_mode = preset["rf_mode"]
            gamma = preset["gamma"]
            beta = preset["beta"]
            high_scale_start = preset["high_scale_start"]
            high_scale_end = preset["high_scale_end"]
            low_scale_start = preset["low_scale_start"]
            low_scale_end = preset["low_scale_end"]
            adain_strength = preset["adain_strength"]
            blocks = preset["blocks"]

        strength = max(0.0, float(style_strength))
        cfg = {
            "method": "controlled",
            "beta": float(beta),
            "high_scale_start": float(high_scale_start),
            "high_scale_end": float(high_scale_end),
            "low_scale_start": float(low_scale_start),
            "low_scale_end": float(low_scale_end),
            "adain_strength": float(adain_strength),
            "blocks": str(blocks or "7-27"),
            "value_mode": "target_adain_plus_ref",
            "value_adain_strength": float(value_adain_strength),
            "ref_value_mix": float(ref_value_mix),
            "ref_k_strength": float(ref_k_strength),
        }
        effective_high = 1.0 + (float(cfg["high_scale_start"]) - 1.0) * min(strength, 1.5)
        effective_low = 1.0 + (float(cfg["low_scale_end"]) - 1.0) * strength
        effective_adain = max(0.0, min(1.0, float(cfg["adain_strength"]) * min(strength, 1.25)))
        active_blocks = _parse_blocks(str(cfg["blocks"]))

        model_clone = model.clone()
        model_clone.model_options = _clone_model_options(model_clone.model_options)
        dm = _find_diffusion_model(model_clone)
        matched, installed = _patch_krea2_attention(dm)

        state: Dict[str, Any] = {
            "cache": {0.0: ref_clean.detach().to(device="cpu").clone()},
            "sampler_sigmas": None,
            "schedule_built": False,
            "run_schedules": OrderedDict(),
            "rf_context_keys": OrderedDict(),
            "_schedule_lock": threading.RLock(),
            "_schedule_build_locks": {},
            "_rf_context_build_locks": {},
            "run_generation": 0,
            "eps": None,
            "run_count": 0,
            "rf_build_ms": 0.0,
            "rf_cache_hit": False,
        }
        rf_reference = dict(reference_latent)
        rf_reference["samples"] = reference_latent["samples"]
        rf_reference["krea2_style_transfer_state"] = state
        rf_reference["krea2_style_transfer_ref_clean"] = ref_clean.detach().to(device="cpu").clone()

        def sampler_sample_wrapper(
            executor,
            model_wrap,
            sigmas,
            extra_args,
            callback,
            noise,
            latent_image=None,
            denoise_mask=None,
            disable_pbar=False,
        ):
            found = _coerce_sigma_sequence(sigmas)
            if found is not None:
                with state["_schedule_lock"]:
                    state["sampler_sigmas"] = list(found)
                    state["schedule_built"] = False
                    state["eps"] = None
                    state["run_count"] = int(state.get("run_count", 0)) + 1
                    _begin_run_schedule_scope(state)
                    state["rf_build_ms"] = 0.0
                    state["rf_cache_hit"] = False
                    state["cache"] = {0.0: ref_clean.detach().to(device="cpu").clone()}
            started = time.perf_counter()
            try:
                return executor(model_wrap, sigmas, extra_args, callback, noise, latent_image, denoise_mask, disable_pbar)
            finally:
                total_ms = (time.perf_counter() - started) * 1000.0
                with state["_schedule_lock"]:
                    build_ms = float(state.get("rf_build_ms", 0.0) or 0.0)
                    cache_hit = bool(state.get("rf_cache_hit", False))
                    run_count = int(state.get("run_count", 0))
                _log_timing(
                    "采样完成",
                    total_ms=total_ms,
                    rf_build_ms=build_ms,
                    sampler_without_rf_ms=max(0.0, total_ms - build_ms),
                    rf_cache_hit=cache_hit,
                    run=run_count,
                )

        comfy.patcher_extension.add_wrapper(
            comfy.patcher_extension.WrappersMP.SAMPLER_SAMPLE,
            sampler_sample_wrapper,
            model_clone.model_options,
            is_model_options=True,
        )

        old_wrapper = model_clone.model_options.get("model_function_wrapper", None)

        def model_function_wrapper(apply_model: Callable, args: Dict[str, Any]) -> torch.Tensor:
            input_x = args.get("input")
            timestep = args.get("timestep")
            if not torch.is_tensor(input_x):
                raise RuntimeError("Krea2 Style Transfer model wrapper received a non-tensor input.")
            c_in = args.get("c", {})
            c = c_in.copy() if isinstance(c_in, dict) else {}
            to = c.get("transformer_options", {}).copy()

            sigma = _sigma_from_timestep(timestep)
            if strength <= 0.0:
                c["transformer_options"] = to
                if old_wrapper is not None:
                    return old_wrapper(
                        apply_model,
                        {
                            "input": input_x,
                            "timestep": timestep,
                            "c": c,
                            "cond_or_uncond": args.get("cond_or_uncond", None),
                        },
                    )
                return apply_model(input_x, timestep, **c)

            sampler_sigmas = _coerce_sigma_sequence(to.get("sample_sigmas"))
            with state["_schedule_lock"]:
                run_generation = int(state.get("run_generation", 0))
                if sampler_sigmas is None:
                    sampler_sigmas = state.get("sampler_sigmas")
            if sampler_sigmas is None:
                raise RuntimeError("Krea2 Style Transfer did not capture the sampler sigma schedule.")
            progress = _sigma_to_progress(sigma, list(sampler_sigmas))
            target_b = int(input_x.shape[0])

            style_cfg: Dict[str, Any] = {
                "enabled": True,
                "method": "controlled",
                "target_batch": target_b,
                "active_blocks": active_blocks,
                "beta": float(cfg["beta"]),
                "high_scale_start": effective_high,
                "high_scale_end": float(cfg["high_scale_end"]),
                "low_scale_start": float(cfg["low_scale_start"]),
                "low_scale_end": effective_low,
                "adain_strength": effective_adain,
                "attention_mix": max(0.0, min(1.0, strength)),
                "value_mode": str(cfg["value_mode"]),
                "value_adain_strength": float(cfg["value_adain_strength"]),
                "ref_value_mix": float(cfg["ref_value_mix"]),
                "ref_k_strength": float(cfg["ref_k_strength"]),
                "progress": progress,
                "sigma": sigma,
            }
            to[_CONFIG_KEY] = style_cfg

            if _has_dynamic_weight_hooks(apply_model):
                raise RuntimeError(
                    "Krea2 参考风格无法安全处理随采样步变化的 WeightHook/LoRA 关键帧。"
                    "请改用固定权重，或移除变化权重关键帧后再生成。"
                )

            rf_dtype = _model_inference_dtype_from_apply_model(apply_model, input_x.dtype)
            _dynamic, hook_token = _active_hook_state(
                getattr(getattr(apply_model, "__self__", None), "current_patcher", None)
            )
            context_token = _rf_run_source_context_token(ref_clean, c, ref_conditioning)
            if _rf_kwargs_has_thread_local_context(c):
                context_token = ("thread-local", threading.get_ident(), context_token)
            context_identity = _rf_run_schedule_key(
                apply_model,
                tuple(input_x.shape),
                rf_dtype,
                list(sampler_sigmas),
                input_x.device,
                tuple(float(value).hex() for value in sampler_sigmas),
                hook_token,
                context_token=context_token,
                run_generation=run_generation,
            )

            def build_rf_context_key():
                ref_for_build = _resize_reference_latent(
                    ref_clean.to(device=input_x.device, dtype=rf_dtype),
                    tuple(int(size) for size in input_x.shape[-2:]),
                )
                ref_for_build = _repeat_to_batch(ref_for_build, target_b)
                rf_kwargs = _build_rf_conditioning_kwargs(c, ref_conditioning, target_b)
                cache_identity = _rf_cache_key(
                    apply_model,
                    ref_for_build,
                    rf_kwargs,
                    list(sampler_sigmas),
                    target_b,
                    rf_dtype,
                    input_x.device,
                    gamma=float(gamma),
                    seed=42,
                    rf_mode=str(rf_mode),
                    include_active_static_hooks=True,
                )
                # Keep tensors and callbacks alive for the whole sampler scope,
                # so identity tokens cannot alias newly allocated objects.
                return cache_identity[0], cache_identity[1], rf_kwargs, ref_for_build

            (
                rf_context_key,
                context_guards,
                rf_kwargs,
                ref_for_build,
            ), _built_context_key = _get_or_build_run_context_key(
                state,
                context_identity,
                build_rf_context_key,
                run_generation=run_generation,
            )
            schedule_key = _rf_run_schedule_key(
                apply_model,
                tuple(input_x.shape),
                rf_dtype,
                list(sampler_sigmas),
                input_x.device,
                tuple(float(value).hex() for value in sampler_sigmas),
                hook_token,
                context_token=rf_context_key or context_identity,
                run_generation=run_generation,
            )

            def build_run_schedule():
                return _prepare_rf_cache(
                    apply_model,
                    ref_for_build,
                    rf_kwargs,
                    list(sampler_sigmas),
                    target_b,
                    rf_dtype,
                    input_x.device,
                    gamma=float(gamma),
                    seed=42,
                    rf_mode=str(rf_mode),
                    cache_identity=(rf_context_key, context_guards),
                )

            (cache, sorted_sigmas, rf_hit, build_ms), built_run_schedule = _get_or_build_run_schedule(
                state,
                schedule_key,
                build_run_schedule,
                run_generation=run_generation,
            )
            if built_run_schedule:
                with state["_schedule_lock"]:
                    if int(state.get("run_generation", 0)) == run_generation:
                        state["cache"] = cache
                        state["eps"] = None
                        state["schedule_built"] = True
                        state["built_sigmas"] = list(sorted_sigmas)
                        state["rf_cache_hit"] = bool(state.get("rf_cache_hit", False) or rf_hit)
                        state["rf_build_ms"] = float(state.get("rf_build_ms", 0.0) or 0.0) + float(build_ms)
                        rf_reference["krea2_style_transfer_state"] = state

            cached, used_sigma = _rf_cache_lookup(cache, sigma)
            if cached is None:
                raise RuntimeError(f"Krea2 Style Transfer has no RF cache entry for sigma={sigma:.6f}.")
            ref_noisy = _repeat_to_batch(cached.to(device=input_x.device, dtype=input_x.dtype), target_b)
            if tuple(ref_noisy.shape[-2:]) != tuple(input_x.shape[-2:]):
                raise RuntimeError(
                    f"Krea2 Style Transfer spatial mismatch: target={tuple(input_x.shape[-2:])}, "
                    f"reference={tuple(ref_noisy.shape[-2:])}. Rebuild reference with the target latent."
                )

            input_for_model = torch.cat([input_x, ref_noisy], dim=0)
            if torch.is_tensor(timestep) and timestep.ndim > 0 and int(timestep.shape[0]) == target_b:
                timestep_for_model = torch.cat([timestep, timestep], dim=0)
            else:
                timestep_for_model = _repeat_to_batch(timestep, target_b * 2)

            c, forced_cap_mask = _merge_reference_conditioning_into_c(c, ref_conditioning, target_b)
            c["transformer_options"] = to
            style_cfg["forced_cap_mask"] = forced_cap_mask.to(device=input_x.device)
            style_cfg["rf_cache_key"] = float(used_sigma)

            cond_or_uncond = args.get("cond_or_uncond", None)
            try:
                if isinstance(cond_or_uncond, list):
                    cond_or_uncond = cond_or_uncond + cond_or_uncond
            except Exception:
                pass

            if old_wrapper is not None:
                raw_result = old_wrapper(
                    apply_model,
                    {
                        "input": input_for_model,
                        "timestep": timestep_for_model,
                        "c": c,
                        "cond_or_uncond": cond_or_uncond,
                    },
                )
            else:
                raw_result = apply_model(input_for_model, timestep_for_model, **c)

            if torch.is_tensor(raw_result) and raw_result.shape[0] >= target_b * 2:
                return raw_result[:target_b]
            return raw_result

        model_clone.set_model_unet_function_wrapper(model_function_wrapper)

        debug = (
            f"single_style_controlled=true; mode={mode}; style_strength={strength:.2f}; "
            f"value_mode={cfg['value_mode']}; value_adain_strength={float(cfg['value_adain_strength']):.2f}; "
            f"ref_value_mix={float(cfg['ref_value_mix']):.2f}; ref_k_strength={float(cfg['ref_k_strength']):.2f}; "
            f"rf_mode={rf_mode}; gamma={float(gamma):.2f}; "
            f"beta={float(cfg['beta']):.2f}; high_scale_start={effective_high:.3f}; "
            f"low_scale_end={effective_low:.3f}; adain_strength={effective_adain:.3f}; "
            f"blocks={cfg['blocks']}; attn_matched={matched}; attn_installed={installed}"
        )
        return model_clone, rf_reference, debug


class Krea2TwoStyleReferences:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "reference_latent_1": ("LATENT",),
                "reference_latent_2": ("LATENT",),
            }
        }

    RETURN_TYPES = ("STYLE_REFS", "STRING")
    RETURN_NAMES = ("style_refs", "debug")
    FUNCTION = "build"
    CATEGORY = _CATEGORY
    DESCRIPTION = "Bundle two prepared Krea2 style reference latents for two-style transfer."

    def build(
        self,
        reference_latent_1,
        reference_latent_2,
        *args,
    ):
        latents = [reference_latent_1, reference_latent_2]
        weights = [1.0, 1.0]
        refs = {
            "latents": latents,
            "weights": weights,
        }
        total = max(1e-6, sum(weights))
        debug = f"multi_refs=true; count={len(latents)}; normalized_weights={','.join(f'{w/total:.3f}' for w in weights)}"
        return refs, debug




class Krea2TwoStyleTransfer:
    _RECOMMENDED = {
        "style_strength": 1.0,
        "ref_k_1": 1.08,
        "ref_k_2": 1.08,
        "stage_schedule": "forward",
        "stage_blend": 0.0,
        "first_phase_ratio": 0.75,
        "stage_focus": 0.85,
        "late_release": 0.0,
        "value_adain_strength": 0.65,
        "ref_value_mix": 1.0,
        "low_scale_end": 1.10,
        "token_rms_cap": 0.0,
        "resolution_gain": 0.0,
        "delta_clip": 0.0,
        "rf_mode": "flowturbo_pc",
        "gamma": 0.5,
        "beta": 2.5,
        "high_scale_start": 1.04,
        "high_scale_end": 0.0,
        "low_scale_start": 1.0,
        "adain_strength": 0.85,
        "blocks": "7-27",
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "style_refs": ("STYLE_REFS",),
                "ref_conditioning": ("CONDITIONING",),
                "mode": (["recommended", "custom"], {"default": "recommended"}),
                "primary_reference": (["1", "2"], {"default": "1"}),
                "style_strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 2.0,
                        "step": 0.05,
                        "advanced": True,
                        "tooltip": "Overall strength for the two-reference route. Recommended mode fixes this at 1.0.",
                    },
                ),
                "ref_k_1": ("FLOAT", {"default": 1.08, "min": 0.0, "max": 5.0, "step": 0.01}),
                "ref_k_2": ("FLOAT", {"default": 1.08, "min": 0.0, "max": 5.0, "step": 0.01}),
                "stage_focus": ("FLOAT", {"default": 0.85, "min": 0.0, "max": 1.0, "step": 0.05}),
                "ref_value_mix": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "low_scale_end": ("FLOAT", {"default": 1.10, "min": -4.0, "max": 8.0, "step": 0.01}),
                "rf_mode": (
                    ["flowturbo_pc", "rf_gamma", "rf_gamma_rk2", "linear"],
                    {"default": "flowturbo_pc", "advanced": True},
                ),
                "gamma": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "advanced": True}),
                "beta": ("FLOAT", {"default": 2.5, "min": 0.01, "max": 20.0, "step": 0.01, "advanced": True}),
                "high_scale_start": ("FLOAT", {"default": 1.04, "min": -4.0, "max": 8.0, "step": 0.01, "advanced": True}),
                "high_scale_end": ("FLOAT", {"default": 0.0, "min": -4.0, "max": 8.0, "step": 0.01, "advanced": True}),
                "low_scale_start": ("FLOAT", {"default": 1.0, "min": -4.0, "max": 8.0, "step": 0.01, "advanced": True}),
                "adain_strength": ("FLOAT", {"default": 0.85, "min": 0.0, "max": 1.0, "step": 0.01, "advanced": True}),
                "blocks": ("STRING", {"default": "7-27", "advanced": True}),
                "first_phase_ratio": ("FLOAT", {"default": 0.75, "min": 0.05, "max": 0.95, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("MODEL", "STRING")
    RETURN_NAMES = ("model", "debug")
    FUNCTION = "patch"
    CATEGORY = _CATEGORY
    DESCRIPTION = "Training-free multi-reference style route with a recommended preset and optional custom controls."

    def patch(
        self,
        model,
        style_refs,
        ref_conditioning,
        mode,
        style_strength,
        primary_reference,
        ref_k_1,
        ref_k_2,
        stage_focus,
        ref_value_mix,
        low_scale_end,
        rf_mode,
        gamma,
        beta,
        high_scale_start,
        high_scale_end,
        low_scale_start,
        adain_strength,
        blocks,
        first_phase_ratio,
    ):
        if not isinstance(style_refs, dict) or not style_refs.get("latents"):
            raise ValueError("style_refs must come from Krea2 Two Style References.")
        ref_latents = list(style_refs.get("latents", []))[:2]
        ref_weights = list(style_refs.get("weights", []))[: len(ref_latents)]
        if len(ref_latents) < 2:
            raise ValueError("Krea2 Two Style Transfer requires at least two reference latents.")
        ref_clean_list = []
        for idx, latent in enumerate(ref_latents):
            if not isinstance(latent, dict) or "samples" not in latent:
                raise ValueError(f"reference_latent_{idx + 1} must be a LATENT dict with samples.")
            ref_clean_list.append(model.model.process_latent_in(_latent_samples(latent, f"reference_latent_{idx + 1}").detach().clone()))

        mode_s = str(mode)
        if mode_s != "custom":
            mode_s = "recommended"
        preset = self._RECOMMENDED
        stage_schedule = preset["stage_schedule"]
        stage_blend = preset["stage_blend"]
        first_phase_ratio = float(first_phase_ratio)
        late_release = preset["late_release"]
        value_adain_strength = preset["value_adain_strength"]
        token_rms_cap = preset["token_rms_cap"]
        resolution_gain = preset["resolution_gain"]
        delta_clip = preset["delta_clip"]
        if mode_s == "recommended":
            style_strength = preset["style_strength"]
            ref_k_1 = preset["ref_k_1"]
            ref_k_2 = preset["ref_k_2"]
            first_phase_ratio = preset["first_phase_ratio"]
            stage_focus = preset["stage_focus"]
            ref_value_mix = preset["ref_value_mix"]
            low_scale_end = preset["low_scale_end"]
            rf_mode = preset["rf_mode"]
            gamma = preset["gamma"]
            beta = preset["beta"]
            high_scale_start = preset["high_scale_start"]
            high_scale_end = preset["high_scale_end"]
            low_scale_start = preset["low_scale_start"]
            adain_strength = preset["adain_strength"]
            blocks = preset["blocks"]
        primary_idx = _primary_reference_index(primary_reference, len(ref_clean_list))
        stage_shift = _stage_shift_for_primary(len(ref_clean_list), str(stage_schedule), primary_idx)

        strength = max(0.0, float(style_strength))
        effective_high = 1.0 + (float(high_scale_start) - 1.0) * min(strength, 1.5)
        effective_low = 1.0 + (float(low_scale_end) - 1.0) * strength
        effective_adain = max(0.0, min(1.0, float(adain_strength) * min(strength, 1.25)))
        active_blocks = _parse_blocks(str(blocks or "7-27"))
        weights_f = [max(0.0, float(w)) for w in ref_weights]
        total_w = sum(weights_f)
        if total_w <= 0:
            weights_f = [1.0 / len(ref_clean_list)] * len(ref_clean_list)
        else:
            weights_f = [w / total_w for w in weights_f]
        per_ref_k = [float(ref_k_1), float(ref_k_2)][: len(ref_clean_list)]

        model_clone = model.clone()
        model_clone.model_options = _clone_model_options(model_clone.model_options)
        dm = _find_diffusion_model(model_clone)
        matched, installed = _patch_krea2_attention(dm)

        state: Dict[str, Any] = {
            "caches": [{0.0: ref.detach().to(device="cpu").clone()} for ref in ref_clean_list],
            "sampler_sigmas": None,
            "schedule_built": False,
            "eps": None,
            "run_count": 0,
        }

        def sampler_sample_wrapper(
            executor,
            model_wrap,
            sigmas,
            extra_args,
            callback,
            noise,
            latent_image=None,
            denoise_mask=None,
            disable_pbar=False,
        ):
            found = _coerce_sigma_sequence(sigmas)
            if found is not None:
                state["sampler_sigmas"] = list(found)
                state["schedule_built"] = False
                state["eps"] = None
                state["run_count"] = int(state.get("run_count", 0)) + 1
                state["caches"] = [{0.0: ref.detach().to(device="cpu").clone()} for ref in ref_clean_list]
            return executor(model_wrap, sigmas, extra_args, callback, noise, latent_image, denoise_mask, disable_pbar)

        comfy.patcher_extension.add_wrapper(
            comfy.patcher_extension.WrappersMP.SAMPLER_SAMPLE,
            sampler_sample_wrapper,
            model_clone.model_options,
            is_model_options=True,
        )

        old_wrapper = model_clone.model_options.get("model_function_wrapper", None)

        def model_function_wrapper(apply_model: Callable, args: Dict[str, Any]) -> torch.Tensor:
            input_x = args.get("input")
            timestep = args.get("timestep")
            if not torch.is_tensor(input_x):
                raise RuntimeError("Krea2 Two Style received a non-tensor input.")
            c_in = args.get("c", {})
            c = c_in.copy() if isinstance(c_in, dict) else {}
            to = c.get("transformer_options", {}).copy()
            sigma = _sigma_from_timestep(timestep)
            if strength <= 0.0:
                c["transformer_options"] = to
                if old_wrapper is not None:
                    return old_wrapper(apply_model, {"input": input_x, "timestep": timestep, "c": c, "cond_or_uncond": args.get("cond_or_uncond", None)})
                return apply_model(input_x, timestep, **c)

            sampler_sigmas = state.get("sampler_sigmas")
            if sampler_sigmas is None:
                raise RuntimeError("Krea2 Two Style did not capture the sampler sigma schedule.")
            progress = _sigma_to_progress(sigma, list(sampler_sigmas))
            target_b = int(input_x.shape[0])
            style_cfg: Dict[str, Any] = {
                "enabled": True,
                "method": "multi_delta",
                "target_batch": target_b,
                "ref_count": len(ref_clean_list),
                "ref_weights": weights_f,
                "active_blocks": active_blocks,
                "beta": float(beta),
                "high_scale_start": effective_high,
                "high_scale_end": float(high_scale_end),
                "low_scale_start": float(low_scale_start),
                "low_scale_end": effective_low,
                "adain_strength": effective_adain,
                "attention_mix": max(0.0, min(1.0, strength)),
                "value_adain_strength": float(value_adain_strength),
                "ref_value_mix": float(ref_value_mix),
                "ref_k_strength": 1.04,
                "per_ref_k_strengths": per_ref_k,
                "fusion_mode": "step_cycle",
                "stage_schedule": str(stage_schedule),
                "stage_shift": int(stage_shift),
                "stage_blend": float(stage_blend),
                "first_phase_ratio": float(first_phase_ratio),
                "rotate_strength": float(stage_focus),
                "late_release": float(late_release),
                "resolution_gain": float(resolution_gain),
                "delta_clip": float(delta_clip),
                "token_rms_cap": float(token_rms_cap),
                "progress": progress,
                "sigma": sigma,
            }
            to[_CONFIG_KEY] = style_cfg

            if not state.get("schedule_built", False):
                caches = []
                rf_dtype = _model_inference_dtype_from_apply_model(apply_model, input_x.dtype)
                for ref_clean in ref_clean_list:
                    ref_for_build = _repeat_to_batch(ref_clean.to(device=input_x.device, dtype=rf_dtype), target_b)
                    rf_kwargs = _build_rf_conditioning_kwargs(c, ref_conditioning, target_b)
                    cache, eps, sorted_sigmas = _build_rf_cache(
                        ref_for_build,
                        list(sampler_sigmas),
                        _make_raw_velocity_apply_model_fn(apply_model),
                        rf_kwargs,
                        gamma=float(gamma),
                        seed=42,
                        rf_mode=str(rf_mode),
                    )
                    caches.append({float(k): v.detach() for k, v in cache.items()})
                    state["eps"] = eps.detach()
                    state["built_sigmas"] = list(sorted_sigmas)
                state["caches"] = caches
                state["schedule_built"] = True

            refs_noisy = []
            used_keys = []
            for cache in state.get("caches", []):
                cached, used_sigma = _rf_cache_lookup(cache, sigma)
                if cached is None:
                    raise RuntimeError(f"Krea2 Two Style has no RF cache entry for sigma={sigma:.6f}.")
                refs_noisy.append(_repeat_to_batch(cached.to(device=input_x.device, dtype=input_x.dtype), target_b))
                used_keys.append(float(used_sigma))
            for ref_noisy in refs_noisy:
                if tuple(ref_noisy.shape[-2:]) != tuple(input_x.shape[-2:]):
                    raise RuntimeError(
                        f"Krea2 Two Style spatial mismatch: target={tuple(input_x.shape[-2:])}, "
                        f"reference={tuple(ref_noisy.shape[-2:])}. Rebuild references with the target latent."
                    )
            input_for_model = torch.cat([input_x] + refs_noisy, dim=0)
            if torch.is_tensor(timestep) and timestep.ndim > 0 and int(timestep.shape[0]) == target_b:
                timestep_for_model = torch.cat([timestep] * (1 + len(refs_noisy)), dim=0)
            else:
                timestep_for_model = _repeat_to_batch(timestep, target_b * (1 + len(refs_noisy)))

            c, forced_cap_mask = _merge_multi_reference_conditioning_into_c(c, [ref_conditioning] * len(refs_noisy), target_b)
            c["transformer_options"] = to
            style_cfg["forced_cap_mask"] = forced_cap_mask.to(device=input_x.device)
            style_cfg["rf_cache_keys"] = used_keys
            cond_or_uncond = args.get("cond_or_uncond", None)
            try:
                if isinstance(cond_or_uncond, list):
                    cond_or_uncond = cond_or_uncond * (1 + len(refs_noisy))
            except Exception:
                pass
            if old_wrapper is not None:
                raw_result = old_wrapper(
                    apply_model,
                    {"input": input_for_model, "timestep": timestep_for_model, "c": c, "cond_or_uncond": cond_or_uncond},
                )
            else:
                raw_result = apply_model(input_for_model, timestep_for_model, **c)
            if torch.is_tensor(raw_result) and raw_result.shape[0] >= target_b * (1 + len(refs_noisy)):
                return raw_result[:target_b]
            return raw_result

        model_clone.set_model_unet_function_wrapper(model_function_wrapper)
        debug = (
            f"multi_style_stage=true; mode={mode_s}; count={len(ref_clean_list)}; weights={','.join(f'{w:.3f}' for w in weights_f)}; "
            f"style_strength={strength:.2f}; primary_reference={primary_idx + 1}; schedule={stage_schedule}; stage_shift={int(stage_shift)}; "
            f"stage_blend={float(stage_blend):.2f}; first_phase_ratio={float(first_phase_ratio):.2f}; "
            f"stage_focus={float(stage_focus):.2f}; late_release={float(late_release):.2f}; "
            f"ref_k={','.join(f'{k:.3f}' for k in per_ref_k)}; ref_value_mix={float(ref_value_mix):.2f}; "
            f"low_scale_end={effective_low:.3f}; token_rms_cap={float(token_rms_cap):.2f}; resolution_gain={float(resolution_gain):.2f}; "
            f"blocks={blocks}; attn_matched={matched}; attn_installed={installed}"
        )
        return model_clone, debug


class Krea2SizePreset:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "resolution": (["0.5K", "1K", "1.5K", "2K"], {"default": "1K"}),
                "aspect_ratio": (
                    ["1:1", "9:16", "16:9", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "21:9"],
                    {"default": "16:9"},
                ),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "build"
    CATEGORY = _CATEGORY
    DESCRIPTION = "Convenience latent size preset for Krea2 workflows."

    def build(self, resolution, aspect_ratio, batch_size):
        width, height = _SIZE_PRESETS[(str(resolution), str(aspect_ratio))]
        return (_empty_latent(width, height, int(batch_size)),)






NODE_CLASS_MAPPINGS = {
    "Krea2StyleReference": Krea2StyleReference,
    "Krea2StyleTransfer": Krea2StyleTransfer,
    "Krea2TwoStyleReferences": Krea2TwoStyleReferences,
    "Krea2TwoStyleTransfer": Krea2TwoStyleTransfer,
    "Krea2SizePreset": Krea2SizePreset,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Krea2StyleReference": "Krea2 Style Reference",
    "Krea2StyleTransfer": "Krea2 Style Transfer",
    "Krea2TwoStyleReferences": "Krea2 Two Style References",
    "Krea2TwoStyleTransfer": "Krea2 Two Style Transfer",
    "Krea2SizePreset": "Krea2 Size Preset",
}

