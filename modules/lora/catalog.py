"""Only resolve filenames registered with ComfyUI; never accept arbitrary paths."""
import threading
import time
from pathlib import Path
from .core import Missing, filename


class Catalog:
    def __init__(self, paths):
        self.paths = paths
        self._names = {}
        self._updated = 0
        self._lock = threading.RLock()

    def scan(self, refresh=False):
        with self._lock:
            if refresh or time.monotonic() - self._updated > 5:
                self._names = {filename(n): n for n in self.paths.get_filename_list("loras")}
                self._updated = time.monotonic()
            return dict(self._names)

    def resolve(self, name):
        name = filename(name)
        names = self.scan()
        if name not in names:
            names = self.scan(True)
        original = names.get(name)
        path = self.paths.get_full_path("loras", original) if original else None
        if not path or not Path(path).is_file():
            raise Missing(f"找不到 LoRA：{name}。请恢复文件或重新关联，未自动替换。")
        return Path(path)

    def signature(self, name):
        path = self.resolve(name)
        stat = path.stat()
        return str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
