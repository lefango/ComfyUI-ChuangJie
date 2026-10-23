import {app} from "../../scripts/app.js";
import {api} from "../../scripts/api.js";
import {Client,BASE,el,button,openManager,confirmDialog} from "./unified-v0.2.27/manager.mjs";
import {emptyState,parseState,outputs,inputs,digest,summary,modelFamily,qwenImage21EditCapable} from "./unified-v0.2.27/state.mjs";
import {PromptView,promptStylesheetUrl} from "./unified-v0.2.27/prompt/index.mjs";
import {normalizeCoverBlob} from "./unified-v0.2.27/prompt/cover.mjs";
import {openImageEditLibrary,openMaskEditor} from "./unified-v0.2.27/image-editor.mjs";
import {mountCollectionConsole} from "./unified-v0.2.27/collection-console/collection-console.mjs";
import {legacyPanelRoute,toSamplerWidgetValue} from "./unified-v0.2.27/collection-console-adapter.mjs";
import {historyBelongsToActivePrompt,samplerPreviewBelongsToNode,withLivePreviewOptions} from "./unified-v0.2.27/preview-events.mjs";
import {normalizeSamplerConfig,randomSafeSeed,randomizeSamplingConfigAfterQueue} from "./unified-v0.2.27/sampler-seed.mjs";

const stylesheet = (file) => { const link = el("link"); link.rel = "stylesheet"; link.href = new URL(file, import.meta.url).href; document.head.append(link); };
for (const file of ["./unified-v0.2.27/lora/manager.css", "./unified-v0.2.27/style.css", "./unified-v0.2.27/image-editor.css", "./unified-v0.2.27/collection-console/collection-console.css", promptStylesheetUrl]) stylesheet(file);

const client = new Client((url, options) => api.fetchApi(url, options), (scope, key) => api.apiURL(BASE + scope + "/covers/" + key));
const previews = new WeakMap();
const live = new Set();
let sequence = 0;
let watchTimer = null;
const TASK_SUFFIXES = ["model", "clip", "vae", "lora-model", "lora-clip", "triggers", "prompt", "empty-latent", "edit-image", "vae-encode", "vae-encode-inpaint", "ksampler", "vae-decode", "sample-preview", "mask-composite", "final-preview"];
const INTERNAL_CLASSES = new Set(["CJUnifiedAssetTest", "CJUnifiedLoRATest", "CJUnifiedTriggersTest", "CJUnifiedPromptStageTest", "CJUnifiedEditImageStageTest", "CJUnifiedMaskCompositeStageTest"]);
const linkAt = (graph, id) => graph?.links?.get?.(id) || graph?.links?.[id] || graph?._links?.get?.(id) || graph?._links?.[id];

function localized(node) {
    const labels = {config:"一体节点配置", positive:"正面提示词", negative:"负面提示词", prompt_config:"提示词设置", text_output_enabled:"独立文本输出", text_output_user:"文本输出包含用户输入", text_output_extra:"文本输出包含上游补充", text_output_presets:"文本输出包含预设", text_output_styles:"文本输出包含风格", latent_width:"图像宽度", latent_height:"图像高度", latent_batch_size:"批量数量", sampling_config:"K 采样器设置", model:"外部模型", clip:"外部 CLIP", vae:"外部 VAE", kind:"模型类别", files:"文件列表", options_json:"加载参数"};
    for (const port of [...(node.inputs || []), ...(node.widgets || [])]) if (Object.hasOwn(labels, port.name)) port.label = labels[port.name];
}
function connections(node) {
    return (node.outputs || []).flatMap((port, index) => (port.links || []).map(id => {
        const link = linkAt(node.graph, id);
        return link ? {id:port.name,index,target:link.target_id,input:link.target_slot,reroute:link.parentId} : null;
    }).filter(Boolean));
}
export function syncPorts(node, state, restoring = false) {
    node.properties ??= {};
    const wanted = outputs(state), wantedInputs = inputs(state), ids = node.properties.cj_unified_output_ids;
    for (const [index, port] of (node.outputs || []).entries()) port.name = ids?.[index] || (restoring ? wanted[index]?.id : null) || port.name;
    for (let index = (node.outputs?.length || 0) - 1; index >= 0; index--) if (!wanted.some(port => port.id === node.outputs[index].name)) node.removeOutput(index);
    for (const port of wanted) if (!node.outputs?.some(output => output.name === port.id)) node.addOutput(port.id, port.type);
    if ((node.outputs || []).some((port, index) => port.name !== wanted[index]?.id)) {
        const oldLinks = connections(node);
        for (let index = node.outputs.length - 1; index >= 0; index--) node.removeOutput(index);
        for (const port of wanted) node.addOutput(port.id, port.type);
        for (const old of oldLinks) {
            const index = wanted.findIndex(port => port.id === old.id), target = node.graph?.getNodeById(old.target);
            if (index >= 0 && target) node.connect(index, target, old.input, old.reroute);
        }
    }
    wanted.forEach((port, index) => Object.assign(node.outputs[index], {name:port.id,type:port.type,label:port.label,localized_name:port.label,slot_index:index}));
    for (let index = (node.inputs?.length || 0) - 1; index >= 0; index--) {
        const port = node.inputs[index];
        if (["model", "clip", "vae", "positive_extra", "negative_extra"].includes(port.name) && !wantedInputs.some(item => item.id === port.name)) node.removeInput(index);
    }
    for (const port of wantedInputs) {
        if (!node.inputs?.some(input => input.name === port.id)) node.addInput(port.id, port.type);
        const actual = node.inputs.find(input => input.name === port.id); actual.label = port.label; actual.localized_name = port.label;
    }
    node.properties.cj_unified_output_ids = wanted.map(port => port.id);
    localized(node); node.setDirtyCanvas?.(true, true);
}

async function readResponse(response, responseType) {
    if (!response.ok) {
        let payload = {}; try { payload = await response.json(); } catch { /* use the status text */ }
        throw Error(payload.error || payload.message || ("请求失败：HTTP " + response.status));
    }
    if (responseType === "blob") return response.blob();
    if (response.status === 204) return {};
    return response.json();
}
async function imageEditRequest(path, options = {}) {
    const response = await api.fetchApi(BASE + path, options);
    return readResponse(response, options.responseType);
}
async function promptRequest(operation, body) {
    if (operation === "style-cover") {
        const response = await api.fetchApi("/prompt-manager/v1/style-cover/" + encodeURIComponent(body));
        return readResponse(response, "blob");
    }
    const method = body === undefined ? {} : {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)};
    return readResponse(await api.fetchApi("/prompt-manager/v1/" + operation, method));
}
function jsonPost(body) { return {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}; }
function blobDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(Error("封面编码失败"));
        reader.onerror = () => reject(Error("封面读取失败"));
        reader.readAsDataURL(blob);
    });
}
function createStyleCoverCache(request, {maxBytes = 32 * 1024 * 1024, maxEntries = 12, maxAgeMs = 8 * 60000,
    now = () => Date.now(), log = (event, fields) => console.debug("[风格参考] " + event, fields)} = {}) {
    const entries = new Map();
    let bytes = 0;
    function drop(key) {
        const entry = entries.get(key);
        if (!entry) return;
        entries.delete(key);
        bytes -= entry.blob.size;
    }
    function trim() {
        while (entries.size && (entries.size > maxEntries || bytes > maxBytes)) drop(entries.keys().next().value);
    }
    return async function styleCoverRequest(style) {
        const key = String(style?.image || "") + "|" + String(style?.revision ?? "");
        const cached = entries.get(key);
        if (cached && now() - cached.at <= maxAgeMs) {
            entries.delete(key); entries.set(key, cached);
            log("封面缓存命中", {bytes:cached.blob.size});
            return cached.blob;
        }
        if (cached) drop(key);
        const started = now();
        const blob = await request("style-cover", style.image);
        const elapsedMs = now() - started;
        if (!(blob instanceof Blob)) throw Error("风格封面无效");
        entries.set(key, {blob, at:now()});
        bytes += blob.size;
        trim();
        log("封面请求", {elapsedMs, bytes:blob.size, cached:entries.has(key)});
        return blob;
    };
}
const styleCoverRequest = createStyleCoverCache(promptRequest);
function imageDemanded(output, managerId, state) {
    const index = outputs(state).findIndex(port => port.id === "image");
    if (index < 0) return false;
    return Object.values(output || {}).some(node => Object.values(node?.inputs || {}).some(value => Array.isArray(value) && String(value[0]) === String(managerId) && Number(value[1]) === index));
}
function generationDemanded(output, managerId, state) {
    const indexes = new Set(outputs(state).flatMap((port, index) =>
        ["image", "positive_conditioning", "negative_conditioning", "latent"].includes(port.id) ? [index] : []));
    return Object.values(output || {}).some(node => Object.values(node?.inputs || {}).some(value =>
        Array.isArray(value) && String(value[0]) === String(managerId) && indexes.has(Number(value[1]))));
}
function selectedStyle(configValue) {
    try {
        const config = JSON.parse(configValue || "{}");
        if (!config.style_enabled) return null;
        const style = Array.isArray(config.styles) ? config.styles[0] : null;
        return style && style.image ? style : null;
    } catch { return null; }
}
async function prepareQueueData(data) {
    if (!data || !data.output || typeof data.output !== "object") return data;
    const managers = Object.entries(data.output).filter(([, node]) => node?.class_type === "CJUnifiedModelLoaderTest");
    if (!managers.length) return data;
    const prepared = {...data, output:structuredClone(data.output)};
    for (const [id, node] of Object.entries(prepared.output)) {
        if (node?.class_type !== "CJUnifiedModelLoaderTest") continue;
        const values = node.inputs || {};
        const state = parseState(values.config || JSON.stringify(emptyState()));
        const generate = state.generation.enabled || generationDemanded(prepared.output, id, state);
        values.edit_image_token = ""; values.edit_has_mask = false;
        values.krea_reference_key = ""; values.krea_reference_data = "";
        values.qwen_reference_data = "";
        if (!generate) continue;
        const style = selectedStyle(values.prompt_config);
        const imageId = state.generation.edit_image_id;
        if (imageId && qwenImage21EditCapable(state)) {
            const pending = await imageEditRequest("/image-edit/prepare", jsonPost({id:imageId}));
            values.edit_image_token = pending.token;
            values.edit_has_mask = Boolean(pending.has_mask);
            if (style?.image) {
                const source = await styleCoverRequest(style);
                if (!(source instanceof Blob)) throw Error("Qwen 风格参考图无效");
                const cover = await normalizeCoverBlob(source, 20 * 1024 * 1024);
                if (cover.size > 20 * 1024 * 1024) throw Error("Qwen 风格参考图压缩后仍超过 20 MB");
                const encodeStarted = performance.now();
                values.qwen_reference_data = await blobDataURL(cover);
                console.debug("[风格参考] 封面 Base64 编码", {elapsedMs:Math.round(performance.now() - encodeStarted), bytes:cover.size});
            }
        }
    }
    return prepared;
}
function installQueueHook(random = Math.random) {
    if (api.__cjUnifiedQueueHook || typeof api.queuePrompt !== "function") return;
    const original = api.queuePrompt;
    let managerQueueTail = Promise.resolve();
    const queuePrompt = async (context, number, data, options) => {
        try {
            const prepared = await prepareQueueData(data);
            const managers = Object.entries(prepared?.output || {})
                .filter(([, node]) => node?.class_type === "CJUnifiedModelLoaderTest")
                .map(([id, node]) => {
                    const preview = [...live].map(ref => ref.deref()).find(item => item && !item.removed && String(item.node.id) === String(id));
                    const input = node.inputs || (node.inputs = {});
                    const current = preview?.widgetValue("sampling_config");
                    if (typeof current === "string") input.sampling_config = current;
                    let submittedSeed;
                    try { submittedSeed = normalizeSamplerConfig(input.sampling_config).seed; } catch { /* The queue response remains authoritative. */ }
                    return {id:String(id),input,preview,submittedSeed};
                });
            const hasManager = managers.length > 0;
            const queued = await original.call(context, number, prepared, hasManager ? withLivePreviewOptions(options) : options);
            const promptId = queued?.prompt_id ?? queued?.promptId ?? queued?.data?.prompt_id;
            if (promptId != null) {
                for (const ref of live) {
                    const preview = ref.deref();
                    if (preview && !preview.removed && managers.some(manager => manager.id === String(preview.node.id))) preview.setActivePrompt(promptId);
                }
                for (const manager of managers) {
                    if (!manager.preview || typeof manager.input.sampling_config !== "string") continue;
                    try {
                        const latest = manager.preview.widgetValue("sampling_config");
                        if (typeof latest !== "string") continue;
                        const current = normalizeSamplerConfig(latest);
                        if (current.control_after_generate === "randomize") {
                            manager.preview.writeWidget("sampling_config", JSON.stringify(randomizeSamplingConfigAfterQueue(current, random, manager.submittedSeed)));
                        }
                    } catch (error) {
                        try { manager.preview.error("队列已接受，但无法更新下一次 K 采样器种子：" + error.message); } catch { /* Keep the accepted queue response intact. */ }
                    }
                }
            }
            return queued;
        } catch (error) {
            for (const ref of live) { const preview = ref.deref(); if (preview && !preview.removed) preview.error(error.message); }
            throw error;
        }
    };
    api.queuePrompt = function(number, data, options) {
        const context = this;
        const hasManager = Object.values(data?.output || {}).some(node => node?.class_type === "CJUnifiedModelLoaderTest");
        if (!hasManager) return queuePrompt(context, number, data, options);
        const operation = managerQueueTail.then(() => queuePrompt(context, number, data, options));
        managerQueueTail = operation.then(() => undefined, () => undefined);
        return operation;
    };
    api.__cjUnifiedQueueHook = true;
}

class Preview {
    constructor(node) {
        this.node = node; this.height = 900; this.removed = false; this.tasks = new Map();
        this.element = el("div", "um-node um-composer");
        this.consoleMount = el("div", "um-console-mount");
        this.legacySurface = el("div", "um-legacy-surface"); this.legacySurface.hidden = true;
        this.toolbar = el("div", "um-composer-toolbar");
        this.columns = el("div", "um-composer-columns");
        this.left = el("div", "um-composer-left"); this.center = el("div", "um-composer-output"); this.right = el("div", "um-composer-output");
        this.status = el("div", "um-composer-status"); this.status.setAttribute("role", "status");
        this.createAssets(); this.createPromptArea(); this.createImageEdit();
        this.createOutput(this.center, "采样结果预览", "等待生成", "sample");
        this.createOutput(this.right, "最终图像预览", "等待生成", "final");
        this.columns.append(this.left, this.center, this.right);
        this.legacySurface.append(this.toolbar, this.columns);
        this.element.append(this.consoleMount, this.status, this.legacySurface);
        this.consolePreviewURLs = { sample: "", final: "" };
        this.editMaskURL = "";
        this.syncingConsole = false;
        this.consoleUI = mountCollectionConsole(this.consoleMount, {
            initialState: this.consoleState(),
            catalog: this.consoleCatalog(),
            onPanelRequest: panel => this.openLegacyPanel(panel),
            onAction: event => this.handleConsoleAction(event),
        });
        this.widget = node.addDOMWidget("unified_composer_" + (++sequence), "unified-model-loader-composer", this.element, {
            serialize:false,hideOnZoom:false,surfaces:{canvas:"shown",vueNode:"shown",panel:"never"},
            getMinHeight:()=>this.height,getHeight:()=>this.height,onDraw:()=>this.update()
        });
        this.widget.serialize = false;
        const oldRemove = this.widget.onRemove;
        this.widget.onRemove = (...args) => { this.removed = true; this.consoleUI?.destroy(); this.promptView?.dispose(); this.releaseImageURL(); this.releaseMaskURL(); this.releasePreviewURLs(); return oldRemove?.apply(this.widget,args); };
        const oldConfigure = node.onConfigure, preview = this;
        node.onConfigure = function(...args) {
            const result = oldConfigure?.apply(this,args), info = args[0];
            const raw = info?.widgets_values_named?.config ?? info?.widgets_values?.[0];
            if (typeof raw === "string") { try { parseState(raw); const config = this.widgets?.find(widget => widget.name === "config"); if (config) config.value = raw; } catch (error) { preview.error(error.message); } }
            queueMicrotask(()=>preview.update(true,true)); return result;
        };
        live.add(new WeakRef(this));
        node.setSize?.([1540, 980]);
        queueMicrotask(()=>this.update(true));
    }
    widgetValue(name, fallback="") { return this.node.widgets?.find(widget=>widget.name===name)?.value ?? fallback; }
    consoleCatalog(state=parseState(this.widgetValue("config", JSON.stringify(emptyState()))), promptConfig=this.promptView.config()) {
        const module=state.modules.model, family=modelFamily(state)||"text", modelId=module.files?.[0]||module.name||"unselected";
        const cover=state.cover||module.cover, scope=state.cover?"":"/models";
        const model={id:modelId,name:module.name||"尚未选择主模型",family,cover:cover?client.imageURL(scope,cover):""};
        const styles=(promptConfig.styles||[]).map(style=>({
            ...style,category:style.category||"风格",
            image:style.image?api.apiURL(`/prompt-manager/v1/style-image/${encodeURIComponent(style.id)}?r=${style.revision}`):"",
        }));
        return {models:[model],styles};
    }
    consoleState(state=parseState(this.widgetValue("config", JSON.stringify(emptyState())))) {
        let promptConfig={presets:[],styles:[]}, sampler={};
        try { promptConfig=this.promptView.config(); } catch { /* Existing prompt config remains visible through its manager. */ }
        try { sampler=JSON.parse(this.widgetValue("sampling_config", "{}"))||{}; } catch { /* The existing KSampler dialog validates edits. */ }
        const module=state.modules.model, family=modelFamily(state)||"text", modelId=module.files?.[0]||module.name||"unselected";
        const cover=state.cover||module.cover, scope=state.cover?"":"/models";
        const selected=this.selectedImage;
        const currentEdit=this.consoleUI?.getState?.().editImage;
        const sameImage=Boolean(currentEdit&&selected&&String(currentEdit.id)===String(selected.id));
        const styles=promptConfig.styles||[], presets=promptConfig.presets||[];
        const currentResolution={width:Number(this.widgetValue("latent_width",1024)),height:Number(this.widgetValue("latent_height",1024))};
        return {
            model:{id:modelId,name:module.name||"尚未选择主模型",family,cover:cover?client.imageURL(scope,cover):""},
            clip:(state.modules.clip.file_names||state.modules.clip.files||[]).slice(),
            vae:state.modules.vae.files?.[0]||"default",
            loras:state.lora.entries||[],
            positivePrompt:String(this.widgetValue("positive","")),
            negativePrompt:String(this.widgetValue("negative","")),
            promptPresets:presets.map(item=>({...item,category:item.category||"已选择"})),
            selectedPromptPreset:presets.find(item=>item.enabled!==false)?.id||"",
            selectedStyleIds:styles.map(item=>item.id),
            resolution:{...currentResolution,ratio:"自定义"},
            sampler:{
                seed:String(sampler.seed??0),steps:Number(sampler.steps??20),cfg:Number(sampler.cfg??7),
                sampler:sampler.sampler_name||"euler",scheduler:sampler.scheduler||"normal",denoise:Number(sampler.denoise??1),
                controlAfterGenerate:normalizeSamplerConfig(sampler).control_after_generate,
            },
            editImage:selected?{
                id:String(selected.id),src:this.editImageURL||"",name:selected.name||"待编辑图片",
                width:Number(selected.width||state.generation.edit_image_width),height:Number(selected.height||state.generation.edit_image_height),
                category:selected.category||"未分类",hasMask:Boolean(selected.has_mask),maskDataUrl:this.editMaskURL||"",
                maskStrokes:sameImage?currentEdit.maskStrokes||[]:[],
            }:{
                id:state.generation.edit_image_id||"",src:"",name:"",width:Number(state.generation.edit_image_width||0),
                height:Number(state.generation.edit_image_height||0),category:"",hasMask:false,maskDataUrl:"",maskStrokes:[],
            },
            previews:{...this.consolePreviewURLs},
        };
    }
    syncConsole(state=parseState(this.widgetValue("config", JSON.stringify(emptyState())))) {
        if(!this.consoleUI)return;
        this.syncingConsole=true;
        try { this.consoleUI.setCatalog(this.consoleCatalog(state)); this.consoleUI.setState(this.consoleState(state)); }
        finally { this.syncingConsole=false; }
    }
    openLegacyPanel(panel) {
        const route=legacyPanelRoute(panel);
        if(!route)return false;
        if(route==="model-manager")this.openManager();
        else if(route==="style-manager")this.promptView.openStyleManager();
        else if(route==="prompt-manager")this.promptView.openPromptManager();
        else if(route==="resolution-selector")this.promptView.openResolutionManager();
        else if(route==="sampler-settings")this.openSamplerSettings();
        else if(route==="image-library")this.openImageLibrary();
        return true;
    }
    handleConsoleAction(event) {
        if(!event||this.syncingConsole||this.removed)return;
        const {type,detail={},state}=event;
        if(["prompt.change","prompt.clear","prompt.paste"].includes(type)){
            this.writeWidget(detail.field==="negative"?"negative":"positive",detail.value??(detail.field==="negative"?state.negativePrompt:state.positivePrompt));
        }else if(type==="resolution.change"){
            this.promptView.setResolution({width:state.resolution.width,height:state.resolution.height,batchSize:Number(this.widgetValue("latent_batch_size",1))});
        }else if(type==="sampler.change"){
            this.writeWidget("sampling_config",toSamplerWidgetValue(state.sampler));
        }else if(type==="editImage.choose"||type==="editImage.drop"){
            if(detail.file)return this.uploadImage(detail.file);
        }else if(type==="editImage.clear"){
            this.clearImage();
        }else if(type==="mask.open"){
            this.openMaskEditor();
        }else if(type==="mask.clear"){
            this.clearMask();
        }else if(type==="mask.change"){
            this.maskSaveQueue=(this.maskSaveQueue||Promise.resolve()).catch(()=>{}).then(()=>this.persistConsoleMask(state)).catch(error=>this.error(error.message));
        }
    }
    async persistConsoleMask(state) {
        const imageId=String(state?.editImage?.id||"");
        if(!imageId||!this.selectedImage)return;
        const strokes=Array.isArray(state.editImage.maskStrokes)?state.editImage.maskStrokes:[];
        if(!strokes.length){
            await imageEditRequest("/image-edit/mask/delete",jsonPost({id:imageId}));
            this.releaseMaskURL();
            this.selectedImage={...this.selectedImage,has_mask:false};
            this.syncConsole();
            this.status.textContent="遮罩已清除；将编辑整张图片。";
            return;
        }
        const width=Number(this.selectedImage.width||state.editImage.width),height=Number(this.selectedImage.height||state.editImage.height);
        if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw Error("图片尺寸无效，无法保存遮罩");
        const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
        const context=canvas.getContext("2d");if(!context)throw Error("浏览器无法创建遮罩画布");
        context.fillStyle="#000";context.fillRect(0,0,width,height);
        try{
            const existing=await imageEditRequest("/image-edit/mask/"+encodeURIComponent(imageId),{responseType:"blob"});
            const url=URL.createObjectURL(existing),image=new Image();
            try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error("已有遮罩无法读取"));image.src=url;});context.drawImage(image,0,0,width,height);}
            finally{URL.revokeObjectURL(url);}
        }catch(error){if(!String(error.message).includes("404"))throw error;}
        context.strokeStyle="#fff";context.fillStyle="#fff";context.lineCap="round";context.lineJoin="round";
        for(const stroke of strokes){
            const points=Array.isArray(stroke.points)?stroke.points:[];if(!points.length)continue;
            context.lineWidth=Math.max(1,Number(stroke.size||0.04)*width);
            if(points.length===1){context.beginPath();context.arc(points[0].x*width,points[0].y*height,context.lineWidth/2,0,Math.PI*2);context.fill();}
            else{context.beginPath();context.moveTo(points[0].x*width,points[0].y*height);for(const point of points.slice(1))context.lineTo(point.x*width,point.y*height);context.stroke();}
        }
        const data=canvas.toDataURL("image/png");
        const result=await imageEditRequest("/image-edit/mask",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:imageId,data})});
        this.selectedImage={...this.selectedImage,has_mask:Boolean(result.has_mask)};
        this.editMaskURL=data;
        this.syncConsole();
        this.status.textContent="遮罩已保存。";
    }
    createAssets() {
        const assets = el("div", "um-assets");
        const model = el("section", "um-panel um-model-card"); model.append(el("h3", "", "模型预设封面"));
        this.modelCover = el("div", "um-card-cover", "未选择模型"); this.modelName = el("strong", "", "模型与 LoRA");
        model.append(this.modelCover, this.modelName);
        assets.append(model); this.left.append(assets);
    }
    createPromptArea() {
        const area = el("section", "um-prompt-area");
        this.promptView = new PromptView(this.node, promptRequest, {mount:area,toolbar:this.toolbar});
        const manage = button("管理模型与 LoRA",()=>this.openManager(),"um-primary");
        this.toolbar.prepend(manage);
        this.toolbar.append(button("K 采样器设置",()=>this.openSamplerSettings()));
        this.promptMount = area; this.left.append(area);
    }
    createImageEdit() {
        const panel = el("section", "um-panel um-edit-panel");
        const header = el("div", "um-edit-header"); header.append(el("h3", "", "图像编辑"));
        this.imageStatus = el("span", "um-muted", "选择待编辑图片");
        this.editButton = button("选择图片",()=>this.openImageLibrary(),"um-primary");
        this.maskButton = button("遮罩",()=>this.openMaskEditor()); this.clearImageButton = button("清除",()=>this.clearImage());
        header.append(this.imageStatus,this.editButton,this.maskButton,this.clearImageButton);
        this.editDrop = el("div", "um-edit-drop");
        this.editImage = el("img", "um-edit-image"); this.editImage.alt = "待编辑图片预览"; this.editImage.hidden = true;
        this.dropHint = el("div", "um-edit-drop-hint", "点击选择或拖入待编辑图片");
        this.editDrop.append(this.editImage,this.dropHint);
        this.editFile = el("input"); this.editFile.type = "file"; this.editFile.accept = "image/png,image/jpeg,image/webp"; this.editFile.hidden = true;
        this.editFile.addEventListener("change",()=>{const file=this.editFile.files?.[0];if(file)this.uploadImage(file).catch(()=>{});this.editFile.value="";});
        this.editDrop.addEventListener("click",event=>{if(event.target===this.editDrop||event.target===this.dropHint)this.editFile.click();});
        this.editDrop.addEventListener("dragover",event=>{event.preventDefault();this.editDrop.classList.add("um-drag-over");});
        this.editDrop.addEventListener("dragleave",()=>this.editDrop.classList.remove("um-drag-over"));
        this.editDrop.addEventListener("drop",event=>{event.preventDefault();this.editDrop.classList.remove("um-drag-over");const file=event.dataTransfer?.files?.[0];if(file)this.uploadImage(file).catch(()=>{});});
        panel.append(header,this.editDrop,this.editFile); this.left.append(panel);
    }
    createOutput(parent, title, placeholder, key) {
        parent.classList.add("um-panel", "um-preview-panel");
        const heading = el("h3", "", title), body = el("div", "um-output-body");
        const image = el("img", "um-output-image"); image.alt = title; image.hidden = true;
        const hint = el("div", "um-output-hint", placeholder); body.append(image,hint); parent.append(heading,body);
        this[key + "Image"] = image; this[key + "Hint"] = hint; this[key + "URL"] = ""; this[key + "Heading"] = heading;
    }
    error(message) { this.element.classList.add("um-has-error"); this.status.textContent=message;this.status.classList.add("um-error"); }
    openManager() {
        const current = this.node.graph?.getNodeById(this.node.id); if(current&&current!==this.node){previews.get(current)?.openManager();return;}
        try { openManager({client,getState:()=>this.node.widgets.find(widget=>widget.name==="config").value,applyState:state=>this.apply(state)}); }
        catch(error){this.error(error.message);}
    }
    async apply(value) {
        if(this.node.graph?.getNodeById(this.node.id)!==this.node){this.error("节点在编辑期间已变化，请重新打开管理窗口");return false;}
        const state=parseState(value), outputIDs=new Set(outputs(state).map(port=>port.id)), inputIDs=new Set(inputs(state).map(port=>port.id));
        const lost=connections(this.node).filter(link=>!outputIDs.has(link.id)).map(link=>this.node.outputs[link.index].label||link.id);
        for(const port of this.node.inputs||[])if(["model","clip","vae"].includes(port.name)&&port.link!=null&&!inputIDs.has(port.name))lost.push("外部输入："+(port.label||port.name));
        if(lost.length&&!await confirmDialog("应用后将断开以下连线：\n"+lost.join("\n"),"确认功能切换与断线"))return false;
        this.node.graph?.beforeChange(); const config=this.node.widgets.find(widget=>widget.name==="config");config.value=JSON.stringify(state);config.callback?.(config.value);this.update(true);this.node.graph?.afterChange();this.node.graph?.change();return true;
    }
    writeWidget(name,value) {
        const widget=this.node.widgets?.find(item=>item.name===name);if(!widget)return;
        widget.value=value;widget.callback?.(value);this.node.graph?.change();this.node.setDirtyCanvas?.(true,true);
    }
    async setGenerationImage(item) {
        const config=this.node.widgets?.find(widget=>widget.name==="config");if(!config)return;
        const state=parseState(config.value||JSON.stringify(emptyState()));
        state.generation={...state.generation,edit_image_id:String(item.id),edit_image_width:Number(item.width),edit_image_height:Number(item.height)};
        if(String(this.selectedImage?.id||"")!==String(item.id)){this.releaseImageURL();this.releaseMaskURL();}
        config.value=JSON.stringify(state);config.callback?.(config.value);this.node.graph?.change();this.selectedImage=item;this.update(true);await this.loadSelectedImage(true);
    }
    async clearImage() {
        const config=this.node.widgets?.find(widget=>widget.name==="config");if(!config)return;
        const state=parseState(config.value||JSON.stringify(emptyState()));state.generation={...state.generation,edit_image_id:"",edit_image_width:0,edit_image_height:0};
        config.value=JSON.stringify(state);config.callback?.(config.value);this.node.graph?.change();this.update(true);this.releaseImageURL();this.releaseMaskURL();this.selectedImage=null;this.imageForId="";this.editImage.hidden=true;this.dropHint.hidden=false;this.imageStatus.textContent="选择待编辑图片";this.syncConsole();
    }
    async openImageLibrary() {
        try { openImageEditLibrary({request:imageEditRequest,selectedId:this.selectedImage?.id||null,onSelect:item=>this.setGenerationImage(item)}); }
        catch(error){this.error(error.message);}
    }
    async openMaskEditor() {
        if(!this.selectedImage)return;
        try { openMaskEditor({request:imageEditRequest,image:this.selectedImage,onSave:(result,data)=>{this.selectedImage={...this.selectedImage,...result,has_mask:Boolean(result?.has_mask??data)};if(data)this.editMaskURL=data;else this.releaseMaskURL();this.imageStatus.textContent=(this.selectedImage.name||"待编辑图片")+(this.selectedImage.has_mask?" · 已设置遮罩":" · 整图编辑");this.syncConsole();}}); }
        catch(error){this.error(error.message);}
    }
    async clearMask() {
        const id=this.selectedImage?.id;
        if(!id)return;
        try {
            await imageEditRequest("/image-edit/mask/delete",jsonPost({id}));
            this.selectedImage={...this.selectedImage,has_mask:false};
            this.releaseMaskURL();
            this.syncConsole();
            this.status.textContent="遮罩已清除；将编辑整张图片。";
        } catch(error){this.error(error.message);}
    }
    async uploadImage(file) {
        const serial=this.imageUploadSerial=(this.imageUploadSerial||0)+1;
        if(!/^image\/(png|jpeg|webp)$/.test(String(file?.type||"").toLowerCase())){
            this.error("仅支持 PNG、JPEG、WebP 图片");
            this.syncConsole();
            throw Error("仅支持 PNG、JPEG、WebP 图片");
        }
        const form=new FormData();form.append("file",file);
        try {
            const item=await imageEditRequest("/image-edit/upload",{method:"POST",body:form});
            if(serial!==this.imageUploadSerial)return null;
            await this.setGenerationImage(item);
            const selected=this.consoleUI?.getState?.().editImage;
            return selected?.id?selected:{...item,src:this.editImageURL||""};
        } catch(error){
            if(serial===this.imageUploadSerial){this.syncConsole();this.error("图片上传失败："+error.message);}
            throw error;
        }
    }
    releaseImageURL() { if(this.editImageURL){URL.revokeObjectURL(this.editImageURL);this.editImageURL="";} }
    releaseMaskURL() { if(String(this.editMaskURL||"").startsWith("blob:"))URL.revokeObjectURL(this.editMaskURL);this.editMaskURL=""; }
    async loadSelectedImage(force=false) {
        const raw=this.node.widgets?.find(widget=>widget.name==="config")?.value;let state;
        try{state=parseState(raw||JSON.stringify(emptyState()));}catch{return;}
        const id=state.generation.edit_image_id;
        if(!id){this.selectedImage=null;this.imageForId="";this.releaseImageURL();this.releaseMaskURL();this.editImage.hidden=true;this.dropHint.hidden=false;this.syncConsole();return;}
        if(!force&&this.imageForId===id)return;
        if(String(this.selectedImage?.id||"")!==id){this.selectedImage=null;this.releaseImageURL();this.releaseMaskURL();}
        this.imageForId=id;this.imageStatus.textContent="正在读取待编辑图片…";this.editImage.hidden=true;this.dropHint.hidden=false;
        try {
            const library=await imageEditRequest("/image-edit/library");
            const item=(library.images||[]).find(entry=>entry.id===id)||{id,name:"待编辑图片",width:state.generation.edit_image_width,height:state.generation.edit_image_height,has_mask:false};
            if(this.imageForId!==id)return;
            this.selectedImage=item;
            const blob=await imageEditRequest("/image-edit/image/"+encodeURIComponent(id),{responseType:"blob"});
            let maskBlob=null;
            if(item.has_mask){
                try{maskBlob=await imageEditRequest("/image-edit/mask/"+encodeURIComponent(id),{responseType:"blob"});}
                catch(error){if(!String(error.message).includes("404"))throw error;}
            }
            if(this.imageForId!==id)return;
            this.releaseImageURL();this.releaseMaskURL();this.editImageURL=URL.createObjectURL(blob);this.editMaskURL=maskBlob?URL.createObjectURL(maskBlob):"";this.editImage.src=this.editImageURL;this.editImage.hidden=false;this.dropHint.hidden=true;this.syncConsole();
            this.imageStatus.textContent=(item.name||"待编辑图片")+(item.has_mask?" · 已设置遮罩":" · 整图编辑");this.maskButton.textContent=item.has_mask?"遮罩 · 已设置":"遮罩";
        } catch(error) {if(this.imageForId===id)this.imageStatus.textContent="图片读取失败："+error.message;}
    }
    async openSamplerSettings() {
        try {
            const options=await client.request("/sampling-options");
            const configWidget=this.node.widgets?.find(widget=>widget.name==="sampling_config");
            const current=normalizeSamplerConfig(JSON.parse(configWidget?.value||"{}"));
            const dialog=el("dialog","um-confirm um-sampling-dialog");dialog.setAttribute("aria-label","K 采样器设置");
            const form=el("form");form.append(el("h2","","K 采样器设置"));
            const makeField=(label,control)=>{const wrapper=el("label","um-field");wrapper.append(el("span","",label),control);return wrapper;};
            const number=(value,min,max,step)=>{const input=el("input");input.type="number";input.value=String(value);input.min=String(min);input.max=String(max);input.step=String(step);return input;};
            const seed=number(current.seed??0,0,9007199254740991,1),steps=number(current.steps??20,1,1000,1),cfg=number(current.cfg??7,0,100,0.1),denoise=number(current.denoise??1,0,1,0.01);
            const sampler=el("select"),scheduler=el("select"),controlAfterGenerate=el("select");
            for(const [value,label] of [["fixed","固定"],["randomize","随机"]]){const option=el("option","",label);option.value=value;controlAfterGenerate.append(option);}
            controlAfterGenerate.value=current.control_after_generate;
            for(const [select,values,currentValue] of [[sampler,options.sampler_name||[],current.sampler_name||"euler"],[scheduler,options.scheduler||[],current.scheduler||"normal"]]){
                for(const value of values){const option=el("option","",value);option.value=value;select.append(option);}
                if(![...select.options].some(option=>option.value===currentValue)){const option=el("option","",currentValue);option.value=currentValue;select.append(option);}select.value=currentValue;
            }
            form.append(makeField("种子（0 至 2^53−1）",seed),makeField("生成后控制",controlAfterGenerate),makeField("步数",steps),makeField("CFG",cfg),makeField("采样器",sampler),makeField("调度器",scheduler),makeField("降噪强度",denoise));
            const actions=el("div","um-actions"),random=button("随机种子",()=>{seed.value=String(randomSafeSeed());}),cancel=button("取消",()=>{dialog.close();dialog.remove();}),save=button("应用",()=>{} ,"um-primary");save.type="submit";actions.append(random,cancel,save);form.append(actions);
            form.addEventListener("submit",event=>{event.preventDefault();const value={seed:Number(seed.value),control_after_generate:controlAfterGenerate.value,steps:Number(steps.value),cfg:Number(cfg.value),sampler_name:sampler.value,scheduler:scheduler.value,denoise:Number(denoise.value)};if(!Number.isSafeInteger(value.seed)||value.seed<0||!Number.isInteger(value.steps)||value.steps<1||value.steps>1000||!Number.isFinite(value.cfg)||value.cfg<0||value.cfg>100||!Number.isFinite(value.denoise)||value.denoise<0||value.denoise>1){this.error("K 采样器设置超出有效范围");return;}this.writeWidget("sampling_config",JSON.stringify(value));dialog.close();dialog.remove();});
            dialog.addEventListener("cancel",event=>{event.preventDefault();dialog.close();dialog.remove();});dialog.append(form);document.body.append(dialog);dialog.showModal();
        } catch(error){this.error(error.message);}
    }
    async refreshTasks() {
        const id=String(this.node.id);
        if(this.tasksFor===id&&this.tasks)return this.tasks;
        if(this.tasksFor===id&&this.tasksPromise)return this.tasksPromise;
        this.tasksFor=id;
        this.tasksPromise=(async()=>{
            const response=globalThis.crypto?.subtle?await Promise.all(TASK_SUFFIXES.map(async suffix=>{const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(id+"\0"+suffix));return "__cjum__"+Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("").slice(0,32);})): (await client.request("/task-map",{manager:id})).tasks;
            this.tasks=new Map(TASK_SUFFIXES.map((suffix,index)=>[String(response[index]),suffix]));
            return this.tasks;
        })().catch(error=>{this.tasksFor=null;this.error(error.message);return null;});
        return this.tasksPromise;
    }
    setActivePrompt(promptId) { this.activePromptId=String(promptId);this.legacySamplerPromptId=""; }
    async ownsSamplerNode(nodeId) {
        if(!this.tasks)await this.refreshTasks();
        return Boolean(this.tasks&&this.tasks.get(String(nodeId))==="ksampler");
    }
    async handleLiveSamplerPreview(detail) {
        if(!this.tasks)await this.refreshTasks();
        const samplerNodeId=[...(this.tasks||[])].find(([,suffix])=>suffix==="ksampler")?.[0];
        const samplePreviewNodeId=[...(this.tasks||[])].find(([,suffix])=>suffix==="sample-preview")?.[0];
        if(!samplerNodeId||!samplerPreviewBelongsToNode(detail,{samplerNodeId,samplePreviewNodeId,jobId:this.activePromptId}))return false;
        this.setPreviewURL("sample",URL.createObjectURL(detail.blob),true);
        return true;
    }
    async handleExecuting(detail) {
        const promptId=detail?.prompt_id??detail?.promptId;
        if(promptId==null||String(promptId)!==String(this.activePromptId))return;
        const nodeId=detail?.node??detail?.node_id??detail?.display_node??detail?.displayNodeId;
        this.legacySamplerPromptId=await this.ownsSamplerNode(nodeId)?String(promptId):"";
    }
    async handleProgress(detail) {
        const promptId=detail?.prompt_id??detail?.promptId;
        if(promptId==null||String(promptId)!==String(this.activePromptId))return;
        this.legacySamplerPromptId=await this.ownsSamplerNode(detail?.node)?String(promptId):"";
    }
    handleLegacyPreview(blob) {
        if(!(blob instanceof Blob)||!this.activePromptId||this.legacySamplerPromptId!==String(this.activePromptId))return false;
        this.setPreviewURL("sample",URL.createObjectURL(blob),true);
        return true;
    }
    finishPrompt(promptId) {
        if(String(this.activePromptId)===String(promptId)){this.activePromptId="";this.legacySamplerPromptId="";}
    }
    setPreviewURL(kind,url,live=false) {
        const previous=this.consolePreviewURLs[kind];
        const target=this[kind+"Image"],hint=this[kind+"Hint"];
        if(kind==="sample"&&this.sampleHeading){
            this.sampleHeading.textContent=live?"实时采样预览（潜空间估算）":"采样结果预览";
            this.sampleImage.alt=this.sampleHeading.textContent;
        }
        target.src=url;target.hidden=false;hint.hidden=true;this.consolePreviewURLs[kind]=url;
        this.syncingConsole=true;try{this.consoleUI?.setState({previews:{[kind]:url}});}finally{this.syncingConsole=false;}
        if(previous&&previous!==url&&String(previous).startsWith("blob:"))URL.revokeObjectURL(previous);
    }
    releasePreviewURLs() {
        for(const url of Object.values(this.consolePreviewURLs||{}))if(String(url).startsWith("blob:"))URL.revokeObjectURL(url);
        this.consolePreviewURLs={sample:"",final:""};
    }
    setPreview(kind, images) {
        const image=images?.[0];if(!image)return;
        const params=new URLSearchParams({filename:image.filename||"",subfolder:image.subfolder||"",type:image.type||"temp"});
        params.set("rand",String(Date.now()));
        this.setPreviewURL(kind,api.apiURL("/view?"+params.toString()));
    }
    handleTask(id, output) {
        const suffix=this.tasks?.get(String(id));if(!suffix)return;
        if(suffix==="sample-preview")this.setPreview("sample",output?.images);
        if(suffix==="final-preview")this.setPreview("final",output?.images);
        if(suffix==="prompt"&&output?.prompt_manager)this.promptView.executed(output);
    }
    updateHistory(outputsById) {
        if(!this.tasks)return;
        for(const [id,output] of Object.entries(outputsById||{}))this.handleTask(id,output);
    }
    update(force=false,restoring=false) {
        for(const widget of this.node.widgets||[]){if(widget===this.widget)continue;widget.hidden=true;widget.options??={};widget.options.hidden=true;if(widget.inputEl){widget.inputEl.style.display="none";widget.inputEl.readOnly=true;}}
        const config=this.node.widgets?.find(widget=>widget.name==="config"),raw=config?.value||JSON.stringify(emptyState());
        const snapshot=JSON.stringify([raw,this.widgetValue("positive",""),this.widgetValue("negative",""),this.widgetValue("prompt_config",""),this.widgetValue("latent_width",1024),this.widgetValue("latent_height",1024),this.widgetValue("latent_batch_size",1),this.widgetValue("sampling_config","")]);
        const size=this.node.size||[0,0],minWidth=1360,minHeight=this.height+80;
        if(size[0]<minWidth||size[1]<minHeight)this.node.setSize?.([Math.max(size[0],minWidth),Math.max(size[1],minHeight)]);
        if(!force&&snapshot===this.last)return;this.last=snapshot;
        try {
            const state=parseState(raw);syncPorts(this.node,state,restoring);this.status.textContent="";this.status.classList.remove("um-error");this.element.classList.remove("um-has-error");this.refreshTasks();this.element.title=summary(state);this.modelName.textContent=state.modules.model.name||"尚未选择主模型";
            const cover=state.cover||state.modules.model.cover,scope=state.cover?"":"/models";this.modelCover.replaceChildren();
            if(cover){const image=el("img");image.src=client.imageURL(scope,cover);image.alt=state.name||state.modules.model.name||"模型预设封面";image.addEventListener("error",()=>{image.remove();this.modelCover.textContent="封面不可用";});this.modelCover.append(image);}else this.modelCover.textContent="尚未选择模型";
            if(state.generation.edit_image_id!==this.imageForId)this.loadSelectedImage();
            this.syncConsole(state);
            const serial=this.serial=(this.serial||0)+1;this.node.properties??={};this.element.dataset.modelFamily=modelFamily(state)||"unknown";
            if(state.preset){const check=globalThis.crypto?.subtle?digest(state).then(async value=>value===state.preset.digest?value:(await client.request("/validate",{state})).digest):client.request("/validate",{state}).then(value=>value.digest);check.then(value=>{if(this.serial===serial)this.node.properties.cjUnifiedPresetStatus=value===state.preset.digest?"已保存预设":"已修改";}).catch(error=>{if(this.serial===serial)this.error(error.message);});}
        } catch(error){this.error(error.message);}
    }
}

function watch() {
    if(watchTimer)return;
    watchTimer=setInterval(()=>{for(const ref of live){const preview=ref.deref();if(!preview||preview.removed)live.delete(ref);else if(preview.element.isConnected){localized(preview.node);preview.update();}}if(!live.size){clearInterval(watchTimer);watchTimer=null;}},400);
}
const cachedRuns=new Map();
api.addEventListener("execution_start",()=>{for(const ref of live){const preview=ref.deref();if(preview&&!preview.removed){preview.promptView.executionGraph=preview.promptView.graphKey();preview.status.textContent="正在运行…";}}});
api.addEventListener("executing",event=>{const detail=event.detail||{};for(const ref of live){const preview=ref.deref();if(preview&&!preview.removed)preview.handleExecuting(detail);}});
api.addEventListener("progress",event=>{const detail=event.detail||{};for(const ref of live){const preview=ref.deref();if(preview&&!preview.removed)preview.handleProgress(detail);}});
api.addEventListener("b_preview_with_metadata",event=>{const detail=event.detail||{};for(const ref of live){const preview=ref.deref();if(preview&&!preview.removed)preview.handleLiveSamplerPreview(detail);}});
api.addEventListener("b_preview",event=>{const blob=event.detail;for(const ref of live){const preview=ref.deref();if(preview&&!preview.removed)preview.handleLegacyPreview(blob);}});
api.addEventListener("executed",event=>{const detail=event.detail||{},id=detail.node??detail.node_id,output=detail.output||{};if(id==null)return;for(const ref of live){const preview=ref.deref();if(preview&&!preview.removed)preview.handleTask(id,output);}});
api.addEventListener("execution_cached",event=>{const detail=event.detail||{};if(detail.prompt_id&&Array.isArray(detail.nodes))cachedRuns.set(detail.prompt_id,detail.nodes.map(String));if(cachedRuns.size>32)cachedRuns.delete(cachedRuns.keys().next().value);});
api.addEventListener("execution_success",async event=>{
    const id=event.detail?.prompt_id;if(!id)return;cachedRuns.delete(id);
    try{const response=await api.fetchApi("/history/"+encodeURIComponent(id));if(!response.ok)return;const record=(await response.json())[id];if(!record?.outputs)return;for(const ref of live){const preview=ref.deref();if(preview&&!preview.removed&&historyBelongsToActivePrompt(id,preview.activePromptId)){preview.updateHistory(record.outputs);preview.finishPrompt(id);if(!preview.status.classList.contains("um-error"))preview.status.textContent="生成完成";}}}catch{/* Keep the last preview if history is unavailable. */}
});
api.addEventListener("execution_error",event=>{const detail=event.detail||{},id=String(detail.node_id??detail.node??"");for(const ref of live){const preview=ref.deref();if(preview&&!preview.removed&&(preview.tasks?.has(id)||id===String(preview.node.id)))preview.error(detail.exception_message||detail.message||"内部任务失败，请查看后端日志");}});
app.registerExtension({
    name:"chuangjie.unified-model-loader-test",
    setup(){installQueueHook();},
    nodeCreated(node){
        if(INTERNAL_CLASSES.has(node.comfyClass)){localized(node);return;}
        if(node.comfyClass!=="CJUnifiedModelLoaderTest")return;
        localized(node);
        try { previews.set(node,new Preview(node));watch(); }
        catch(error) {
            console.error("[ComfyUI-ChuangJie] 创界集成控制台挂载失败：" + (error?.stack || error?.message || String(error)));
            throw error;
        }
    },
    loadedGraphNode(node){
        if(INTERNAL_CLASSES.has(node.comfyClass)){localized(node);return;}
        if(node.comfyClass==="CJUnifiedModelLoaderTest"){localized(node);previews.get(node)?.update(true,true);}
    }
});
