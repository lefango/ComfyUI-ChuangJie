export const TYPES = {model:"MODEL",clip:"CLIP",vae:"VAE"};
export const LABELS = {model:"模型",clip:"CLIP",vae:"VAE"};
export const clone = v => JSON.parse(JSON.stringify(v));
export const defaultOptions = () => ({weight_dtype:"default",device:"default",dequant_dtype:"default",patch_dtype:"default",clip_type:"auto",patch_on_device:false,output_model:true,output_clip:true,output_vae:true});
export const emptyState = () => ({version:1,modules:Object.fromEntries(Object.keys(TYPES).map(k=>[k,{source:"internal",files:[],file_names:[],architecture:"",options:defaultOptions(),name:"",cover:null}])),lora:{enabled:true,entries:[],preset:null},preset:null,name:"",cover:null,generation:{enabled:true,edit_image_id:"",edit_image_width:0,edit_image_height:0}});
export function parseState(raw) {
    const s = typeof raw === "string" ? JSON.parse(raw) : clone(raw);
    if (!s || s.version !== 1 || s.mode === "checkpoint" || (s.mode != null && s.mode !== "separate") || s.checkpoint || !s.modules || !s.lora || typeof s.lora.enabled !== "boolean") throw Error("配置版本或结构无效，原配置已保留");
    delete s.mode;delete s.checkpoint;
    for (const k of Object.keys(TYPES)) {
        const m=s.modules[k];
        if (!m || !["internal","external","off"].includes(m.source) || !Array.isArray(m.files) || m.files.length>(k==="clip"?4:1)) throw Error("组件配置无效");
        m.options={...defaultOptions(),...m.options}; m.name??="";m.cover??=null;m.architecture??="";m.file_names??=[];
        if(!Array.isArray(m.file_names)||![0,m.files.length].includes(m.file_names.length))throw Error("模型显示名称与文件数量不一致");
    }
    if (!Array.isArray(s.lora.entries)) throw Error("LoRA 配置无效");
    if (!Object.hasOwn(s, "generation")) s.generation={enabled:false,edit_image_id:"",edit_image_width:0,edit_image_height:0};
    const g=s.generation;
    if (!g || typeof g!=="object" || typeof g.enabled!=="boolean") throw Error("一体出图设置无效");
    g.edit_image_id??="";g.edit_image_width??=0;g.edit_image_height??=0;
    if (g.edit_image_id && (typeof g.edit_image_id !== "string" || !/^[0-9a-f]{32}$/.test(g.edit_image_id))) throw Error("待编辑图片 ID 无效");
    for (const name of ["edit_image_width","edit_image_height"]) if (!Number.isInteger(g[name])||g[name]<0||g[name]>12000) throw Error("待编辑图片尺寸无效");
    if (Boolean(g.edit_image_id)!==Boolean(g.edit_image_width&&g.edit_image_height)) throw Error("待编辑图片及尺寸信息不完整");
    return s;
}
export const outputs = s => [...Object.keys(TYPES).filter(k=>s.modules[k].source!=="off").map(k=>({id:k,type:TYPES[k],label:LABELS[k]})),{id:"image",type:"IMAGE",label:"图像"},{id:"positive_conditioning",type:"CONDITIONING",label:"正面条件"},{id:"negative_conditioning",type:"CONDITIONING",label:"负面条件"},{id:"latent",type:"LATENT",label:"潜空间"}];
export const inputs = s => Object.keys(TYPES).filter(k=>s.modules[k].source==="external").map(k=>({id:k,type:TYPES[k],label:k==="model"?"外部模型":`外部 ${LABELS[k]}`}));
export const stableJSON = v => JSON.stringify(v, function(k,value){return value && typeof value==="object" && !Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value;});
export async function digest(s) {
    const c=clone(s);c.preset=null;
    if (!c.generation?.enabled) delete c.generation;
    for(const m of Object.values(c.modules))for(const field of ["architecture","file_names"])if(!m[field]?.length)delete m[field];
    const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(stableJSON(c)));
    return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
}
export function modelFamily(s) {
    const model=s.modules.model;
    const aliases={sd1:"stable_diffusion",sd15:"stable_diffusion",sd2:"stable_diffusion",sdxl:"stable_diffusion",stable_diffusion:"stable_diffusion",sd3:"sd3",flux:"flux",flux2:"flux2",krea2:"krea2",lumina2:"lumina2",z_image:"lumina2",zimage:"lumina2",qwen_image:"qwen_image",wan:"wan",hidream:"hidream",chroma:"chroma",hunyuan_video:"hunyuan_video"};
    const patterns=[[/(?:^|_)krea_?2(?:_|$)/,"krea2"],[/(?:^|_)flux_?2(?:_|$)/,"flux2"],[/(?:^|_)qwen_?image(?:_|$)/,"qwen_image"],[/(?:^|_)(?:lumina_?2|z_?image)(?:_|$)/,"lumina2"],[/(?:^|_)(?:sdxl|stable_diffusion_xl|stable_diffusion_v[12]|sd_?1_?5|sd_?2)(?:_|$)/,"stable_diffusion"],[/(?:^|_)sd_?3(?:_|$)/,"sd3"],[/(?:^|_)flux(?:_|$)/,"flux"],[/(?:^|_)wan(?:2[12])?(?:_|$)/,"wan"],[/(?:^|_)hidream(?:_|$)/,"hidream"],[/(?:^|_)chroma(?:_|$)/,"chroma"],[/(?:^|_)hunyuan_video(?:_|$)/,"hunyuan_video"]];
    const identify=value=>{const normalized=String(value||"").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");if(aliases[normalized])return aliases[normalized];for(const [pattern,family]of patterns)if(pattern.test(normalized))return family;return null;};
    return identify(model.architecture)||identify(`${model.name||""} ${model.files?.[0]||""}`);
}
export function qwenImage21EditCapable(s) {
    const model=s?.modules?.model||s||{};
    const values=[model.architecture,model.name,...(Array.isArray(model.files)?model.files:[])];
    return values.some(value=>{
        const normalized=String(value||"").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
        return /(?:^|_)qwen_?image_?2_?1(?:_|$)/.test(normalized);
    });
}
export const fileLabel = (file="") => file.replaceAll("\\","/").split("/").pop().replace(/\.[^.]+$/,"");
export const displayName = (name,file) => name&&name!==file?name:fileLabel(file);
export const fileNames = m => m.files.map((file,i)=>displayName(m.file_names?.[i]||(m.files.length===1?m.name:""),file));
export function selectedNames(s,k) {
    return fileNames(s.modules[k]);
}
export function toggleModel(s,item) {
    const kind=item.kind;
    const m=s.modules[kind];if(!m)throw Error("不支持的模型类型");
    const names=fileNames(m),index=m.files.indexOf(item.file);
    if(kind==="clip"){
        if(index>=0){m.files.splice(index,1);names.splice(index,1);}
        else{if(m.files.length>=4)throw Error("CLIP 最多组合四个编码器，请先关闭已有项。");m.files.push(item.file);names.push(item.name||"");}
        m.file_names=m.files.map((file,i)=>names[i]||fileLabel(file));m.name=m.file_names[0]||"";m.cover=m.files.length&&index<0?item.cover||m.cover:null;
        return;
    }
    if(index>=0){m.files=[];m.file_names=[];m.name="";m.cover=null;m.architecture="";}
    else{m.files=[item.file];m.file_names=[item.name||fileLabel(item.file)];m.name=item.name||"";m.cover=item.cover||null;m.architecture=item.architecture||"";}
}
export function summary(s) {
    return Object.keys(TYPES).map(k=>`${LABELS[k]}：${s.modules[k].source==="off"?"关闭":s.modules[k].source==="external"?"外部接入":selectedNames(s,k).join(" + ")||"尚未选择"}`).concat(`LoRA：${s.lora.enabled?s.lora.entries.filter(i=>i.enabled).map(i=>displayName(i.name,i.file)).join("、")||"无启用项":"关闭"}`).join("\n");
}
