import {clone,parseState,LABELS,TYPES,summary,stableJSON,selectedNames,fileNames,toggleModel} from "./state.mjs";
import {Manager as LoRAManager,Client as LoRAClient} from "./lora/manager.mjs";

export const BASE="/cj-unified-loader-test/v1";
export function el(tag,cls="",text) {const e=document.createElement(tag);e.className=cls;if(text!==undefined)e.textContent=text;return e;}
export function button(text,fn,cls="") {const b=el("button",cls,text);b.type="button";b.addEventListener("click",fn);return b;}
function input(value="",type="text") {const e=el("input");e.type=type;if(type==="checkbox")e.checked=Boolean(value);else e.value=value;return e;}
function select(choices,value,change) {const s=el("select");for(const [v,t] of choices){const o=el("option","",t);o.value=v;s.append(o);}s.value=value;s.addEventListener("change",()=>change?.(s.value));return s;}
function field(title,control) {control.setAttribute("aria-label",title);const f=el("label","um-field");f.append(el("span","",title),control);return f;}
export class Client {
    constructor(fetcher,imageURL) {this.fetcher=fetcher;this.imageURL=imageURL;}
    async request(path,body,root=BASE) {
        const r=await this.fetcher(root+path,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
        let v;try{v=await r.json();}catch{throw Error(`请求失败：HTTP ${r.status}`);}if(!r.ok)throw Error(v.error||`HTTP ${r.status}`);return v;
    }
    async upload(file,scope="") {
        const r=await this.fetcher(`${BASE}${scope}/covers`,{method:"POST",body:file,headers:{"Content-Type":"application/octet-stream"}});
        const v=await r.json();if(!r.ok)throw Error(v.error);return v;
    }
}

export function confirmDialog(message,title="确认操作") {
    return new Promise(resolve=>{
        const d=el("dialog","um-confirm"),actions=el("div","um-actions");
        const end=v=>{d.close();d.remove();resolve(v);};
        actions.append(button("取消",()=>end(false)),button("确认",()=>end(true),"um-primary"));
        d.append(el("h2","",title),el("p","um-pre",message),actions);d.addEventListener("cancel",e=>{e.preventDefault();end(false);});document.body.append(d);d.showModal();
    });
}

let active=null;
export function openManager(options) {
    if(active){active.dialog.focus();return active;}
    active=new Manager(options);return active;
}

export class Manager {
    constructor({client,getState,applyState}) {
        this.client=client;this.applyState=applyState;this.state=parseState(getState());this.baseline=stableJSON(this.state);this.tab="models";this.target="model";this.offset=0;this.query="";this.category="";this.status="active";this.format="";this.closed=false;this.serial=0;this.expanded=new Set();
        this.dialog=el("dialog","um-dialog");this.dialog.setAttribute("aria-label","模型与 LoRA 一体管理器");
        const header=el("header","um-header");header.append(el("div","", "模型与 LoRA 一体出图 · 配置管理"),button("关闭",()=>this.close()));
        this.tabs=el("nav","um-tabs");
        for(const [key,name] of [["models","模型配置"],["loras","LoRA 库"],["presets","完整预设"],["features","功能开关"]]){const b=button(name,()=>this.showTab(key));b.dataset.tab=key;this.tabs.append(b);}
        this.body=el("section","um-body");this.message=el("div","um-message");this.message.setAttribute("role","status");
        const foot=el("footer","um-footer");this.short=el("span","um-muted");
        foot.append(this.short,button("保存预设",()=>this.run(()=>this.savePreset())),button("取消",()=>this.close()),button("应用到节点",()=>this.run(async()=>{
            const result=await client.request("/validate",{state:this.state});if(await applyState(result.state)===false)return;this.baseline=stableJSON(result.state);this.close(true);
        }),"um-primary"));
        this.dialog.append(header,this.tabs,this.body,this.message,foot);document.body.append(this.dialog);this.dialog.showModal();
        this.dialog.addEventListener("cancel",e=>{e.preventDefault();this.close();});this.showTab("models");
    }
    async run(fn){try{await fn();}catch(e){if(!this.closed){this.message.textContent=e.message;this.message.classList.add("um-error");}}}
    notify(text){this.message.textContent=text;this.message.classList.remove("um-error");}
    changed(){this.short.textContent=`${this.state.name||"当前配置"} · ${this.state.lora.enabled?this.state.lora.entries.filter(i=>i.enabled).length+" 个 LoRA":"LoRA 已关闭"}`;}
    async close(force=false){if(this.closing||this.closed)return;this.closing=true;try{if(!force&&stableJSON(this.state)!==this.baseline&&!await confirmDialog("当前选择尚未应用到节点，关闭会放弃未应用的配置。已保存的公共资料和预设仍会保留。","放弃未应用配置"))return;this.closed=true;this.serial++;this.loraManager?.close();this.modelEditor?.close();this.modelEditor?.remove();this.modelEditor=null;this.dialog.close();this.dialog.remove();active=null;}finally{this.closing=false;}}
    showTab(key){this.serial++;clearTimeout(this.timer);this.loraManager?.close();this.loraManager=null;this.tab=key;this.body.classList.toggle("um-lora-page",key==="loras");this.modelEditor?.close();this.modelEditor?.remove();this.modelEditor=null;this.body.replaceChildren();this.message.textContent="";for(const b of this.tabs.children)b.classList.toggle("um-selected",b.dataset.tab===key);this.changed();this.run(()=>key==="models"?this.models():key==="loras"?this.loras():key==="presets"?this.presets():this.features());}
    features(){
        this.body.append(el("h2","","功能开关"),el("p","um-muted","默认全部开启。关闭保留配置；外部接入可与其他插件组合使用。端口变化在应用后生效。"));
        for(const k of Object.keys(TYPES)){
            const row=el("div","um-feature");const control=select([["internal","内置加载"],["external","外部接入"],["off","关闭"]],this.state.modules[k].source,v=>{this.state.modules[k].source=v;this.changed();});control.setAttribute("aria-label",`${LABELS[k]}功能`);
            row.append(el("strong","",LABELS[k]),control,el("small","um-muted","外部接入显示输入端口；关闭移除对应输入输出。"));this.body.append(row);
        }
        const row=el("div","um-feature"),toggle=input(this.state.lora.enabled,"checkbox");toggle.setAttribute("aria-label","内置 LoRA 功能");toggle.addEventListener("change",()=>{this.state.lora.enabled=toggle.checked;this.changed();});row.append(el("strong","","LoRA"),toggle,el("small","um-muted","关闭后模型和 CLIP 原样输出，可接外部 LoRA；触发词端口隐藏。"));this.body.append(row);
    }
    async models(){
        const epoch=this.serial;
        const [caps,validation]=await Promise.all([this.client.request("/status",undefined,BASE+"/models"),this.client.request("/validate",{state:this.state})]);
        if(this.closed||this.tab!=="models"||epoch!==this.serial)return;
        const config=el("div","um-components");
        for(const k of Object.keys(TYPES)){
            const m=this.state.modules[k],box=el("section","um-component");box.append(el("strong","",LABELS[k]));
            const names=selectedNames(this.state,k);box.append(el("small","um-muted",m.source==="off"?`已关闭 · 保留 ${names.join(" + ")||"未选择"}`:m.source==="external"?"外部接入":names.join(" + ")||"尚未选择"));
            if(k==="clip"&&m.files.length)for(const [i,name]of names.entries()){const row=el("div","um-component-file");row.append(el("small","um-muted",name));for(const [delta,label]of [[-1,"↑"],[1,"↓"]]){const b=button(label,()=>{const labels=fileNames(m);[m.files[i],m.files[i+delta]]=[m.files[i+delta],m.files[i]];[labels[i],labels[i+delta]]=[labels[i+delta],labels[i]];m.file_names=labels;this.showTab("models");});b.disabled=i+delta<0||i+delta>=m.files.length;b.setAttribute("aria-label",`${delta<0?"上移":"下移"} CLIP 编码器 ${name}`);row.append(b);}box.append(row);}
            const advanced=el("details","um-advanced"),settings=el("div","um-options");advanced.open=this.expanded.has(k);advanced.addEventListener("toggle",()=>advanced.open?this.expanded.add(k):this.expanded.delete(k));advanced.append(el("summary","","架构与加载参数"));
            const options=m.options;
            if(k==="clip"){
                settings.append(field("CLIP 用途",select([["auto","自动识别（跟随主模型）"],...(caps.clip_types||[]).map(v=>[v,({stable_diffusion:"SD1／SD2／SDXL",lumina2:"LUMINA2（Z-Image）"})[v]||v.toUpperCase()])],options.clip_type,v=>{options.clip_type=v;this.showTab("models");})),field("加载设备",select([["default","默认"],["cpu","CPU"]],options.device,v=>options.device=v)));
            }
            if(k==="model")for(const [key,label,choices] of [["weight_dtype","权重精度",["default","fp8_e4m3fn","fp8_e4m3fn_fast","fp8_e5m2"]],["dequant_dtype","GGUF 解量化精度",["default","target","float32","float16","bfloat16"]],["patch_dtype","GGUF LoRA 补丁精度",["default","target","float32","float16","bfloat16"]]])settings.append(field(label,select(choices.map(v=>[v,({default:"默认",target:"跟随目标精度",float32:"FP32",float16:"FP16",bfloat16:"BF16",fp8_e4m3fn:"FP8 E4M3FN",fp8_e4m3fn_fast:"FP8 E4M3FN（快速）",fp8_e5m2:"FP8 E5M2"})[v]||v]),options[key],v=>options[key]=v)));
            if(k==="model"){const c=input(options.patch_on_device,"checkbox");c.addEventListener("change",()=>options.patch_on_device=c.checked);settings.append(field("GGUF 在设备上应用补丁",c));}
            advanced.append(settings);if(settings.children.length)box.append(advanced);config.append(box);
        }
        if(this.closed||this.tab!=="models")return;this.body.append(config);
        if(this.state.modules.clip.source==="internal"&&this.state.modules.clip.files.length&&this.state.modules.clip.options.clip_type==="auto"){
            this.body.append(el("p",validation.clip_purpose.type?"um-muted":"um-warning",validation.clip_purpose.type?`已按${validation.clip_purpose.source}自动识别 CLIP 用途：${validation.clip_purpose.type.toUpperCase()}。`:validation.clip_purpose.message));
            if(validation.clip_purpose.type&&!caps.clip_types?.includes(validation.clip_purpose.type))this.body.append(el("p","um-warning",`识别结果为 ${validation.clip_purpose.type.toUpperCase()}，但当前 ComfyUI 未提供该用途支持；请检查版本或手动选择兼容用途。`));
        }
        const toolbar=el("div","um-toolbar"),search=input(this.query,"search");search.placeholder="搜索模型名称、文件名、备注";search.setAttribute("aria-label","搜索模型");search.addEventListener("input",()=>{clearTimeout(this.timer);this.timer=setTimeout(()=>{this.query=search.value;this.offset=0;this.run(()=>this.loadModels());},200);});
        const choices=[["model","选择主模型"],["clip","选择／组合 CLIP"],["vae","选择 VAE"]];
        if(!choices.some(c=>c[0]===this.target))this.target=choices[0][0];
        toolbar.append(select(choices,this.target,v=>{this.target=v;this.offset=0;this.run(()=>this.loadModels());}),select([["","全部格式"],...["gguf","safetensors","ckpt","pt","pth","bin"].map(v=>[v,v])],this.format,v=>{this.format=v;this.offset=0;this.run(()=>this.loadModels());}),search,button("刷新文件",()=>this.run(()=>this.loadModels(true))));
        const area=el("div","um-library-layout");this.categories=el("aside","um-categories");const content=el("div","um-library-content");this.grid=el("div","um-grid");this.pager=el("div","um-actions");content.append(this.grid,this.pager);area.append(this.categories,content);this.body.append(toolbar,area);await this.loadModels();
    }
    async loadModels(refresh=false){
        const token=++this.serial,target=this.target;
        const q=new URLSearchParams({kind:target,q:this.query,category:this.category,status:this.status,format:this.format,offset:this.offset,limit:36,refresh:refresh?1:0});
        const result=await this.client.request("/library?"+q,undefined,BASE+"/models");if(this.closed||token!==this.serial||this.tab!=="models")return;
        this.categories.replaceChildren(button("全部模型",()=>{this.category="";this.status="active";this.offset=0;this.run(()=>this.loadModels());}),button("未启用模型",()=>{this.category="";this.status="disabled";this.offset=0;this.run(()=>this.loadModels());}));
        for(const name of result.categories)this.categories.append(button(name,()=>{this.category=name;this.status="active";this.offset=0;this.run(()=>this.loadModels());}));
        this.categories.append(button("＋ 新建分类",()=>this.run(()=>this.categoryDialog())),...(this.category?[button("删除当前分类",()=>this.run(async()=>{if(await confirmDialog(`删除分类“${this.category}”？模型资料会转为未分类。`)){await this.client.request("/delete-category",{name:this.category},BASE+"/models");this.category="";await this.loadModels();}}))]:[]));
        this.grid.replaceChildren();
        for(const item of result.items){
            const card=el("article","um-card"),cover=el("div","um-cover");this.cover(cover,item.cover,"/models",LABELS[item.kind]);
            const m=this.state.modules[item.kind],selected=m?.files.includes(item.file);
            card.classList.toggle("um-selected",Boolean(selected));card.append(cover,el("strong","",item.name));
            const choose=button(selected?"关闭":"启用",()=>this.run(()=>{toggleModel(this.state,item);this.changed();this.showTab("models");}),selected?"":"um-primary");choose.setAttribute("aria-pressed",String(Boolean(selected)));choose.disabled=Boolean(!selected&&(item.disabled||item.missing));
            card.append(choose,button(item.missing?"资料／重新关联":"编辑资料",()=>this.run(()=>this.editModel(item))));this.grid.append(card);
        }
        if(!result.total)this.grid.append(el("p","um-muted","没有匹配模型，请检查注册模型目录或筛选条件。"));
        const prev=button("上一页",()=>{this.offset=Math.max(0,this.offset-36);this.run(()=>this.loadModels());}),next=button("下一页",()=>{this.offset+=36;this.run(()=>this.loadModels());});prev.disabled=this.offset===0;next.disabled=this.offset+36>=result.total;
        this.pager.replaceChildren(prev,el("span","um-muted",`${result.total} 项 · 第 ${Math.floor(this.offset/36)+1} 页`),next);
    }
    cover(element,key,scope="",fallback="预设") {element.replaceChildren();if(key){const img=el("img");img.src=this.client.imageURL(scope,key);img.alt=fallback;img.loading="lazy";img.addEventListener("error",()=>{img.remove();element.textContent=fallback;});element.append(img);}else element.textContent=fallback;}
    async categoryDialog(){const d=el("dialog","um-confirm"),name=input();d.append(el("h2","","新建模型分类"),field("分类名称",name),button("取消",()=>{d.close();d.remove();}),button("创建",()=>this.run(async()=>{await this.client.request("/create-category",{name:name.value},BASE+"/models");d.close();d.remove();await this.loadModels();}),"um-primary"));document.body.append(d);d.showModal();}
    async editModel(item){
        if(this.modelEditor?.open){this.modelEditor.focus();return;}
        const dialog=el("dialog","lm-editor um-model-dialog");
        dialog.setAttribute("aria-label","编辑模型资料");this.modelEditor=dialog;
        let dismissed=false,committing=false,uploadSerial=0;
        const close=()=>{if(dismissed||committing)return;dismissed=true;uploadSerial++;dialog.close();dialog.remove();if(this.modelEditor===dialog)this.modelEditor=null;};
        dialog.addEventListener("cancel",event=>{event.preventDefault();close();});
        const form=el("form","um-model-editor"),name=input(item.name),notes=el("textarea"),architecture=input(item.architecture||""),category=select([["","未分类"],...Array.from(this.categories.querySelectorAll("button")).map(b=>b.textContent).filter(t=>!["全部模型","未启用模型","＋ 新建分类","删除当前分类"].includes(t)).map(v=>[v,v])],item.category||""),disabled=input(item.disabled,"checkbox"),file=input("","file"),preview=el("div","um-detail-cover"),error=el("div","um-error"),info=el("pre","um-pre um-muted");
        name.required=true;name.maxLength=256;notes.maxLength=32000;architecture.maxLength=80;
        notes.value=item.notes||"";file.accept="image/png,image/jpeg,image/webp";let cover=item.cover||null,uploading=null;
        error.setAttribute("role","alert");
        this.cover(preview,cover,"/models",LABELS[item.kind]);
        file.addEventListener("change",()=>{if(!file.files[0])return;const serial=++uploadSerial;file.disabled=true;uploading=this.client.upload(file.files[0],"/models").then(v=>{if(dismissed||serial!==uploadSerial)return;cover=v.cover;this.cover(preview,cover,"/models",LABELS[item.kind]);}).catch(e=>{if(dismissed||serial!==uploadSerial)return;error.textContent=e.message;throw e;}).finally(()=>file.disabled=false);uploading.catch(()=>{});});
        form.append(el("h2","","编辑模型资料"),preview,el("div","um-pre um-muted",item.file),field("显示名称",name),field("备注",notes),field("架构标签",architecture),field("分类",category),field("停用",disabled),field("上传封面 · PNG / JPEG / WebP，最大 8 MB",file),button("移除封面",()=>{uploadSerial++;cover=null;this.cover(preview,null,"/models",LABELS[item.kind]);}));
        if(item.missing){
            const replacement=input();
            form.append(field("重新关联：准确相对文件名",replacement),button("重新关联文件",async()=>{
                try{
                    await this.client.request("/relink",{kind:item.kind,old:item.file,new:replacement.value,revision:item.revision},BASE+"/models");
                    const m=this.state.modules[item.kind];if(m)m.files=m.files.map(f=>f===item.file?replacement.value:f);
                    close();this.showTab("models");
                }catch(e){error.textContent=e.message;}
            }));
        }
        form.append(button("查看识别信息",async()=>{try{info.textContent=JSON.stringify(await this.client.request("/inspect",{kind:item.kind,file:item.file},BASE+"/models"),null,2);}catch(e){error.textContent=e.message;}}),info,error);
        const actions=el("div","lm-editor-foot"),save=button("保存",()=>{},"lm-primary"),cancel=button("取消",close);save.type="submit";
        actions.append(cancel,save);form.append(actions);
        form.addEventListener("submit",async event=>{
            event.preventDefault();if(dismissed||committing)return;save.disabled=true;error.textContent="";let controls=[];
            try{
                if(uploading)await uploading;
                if(dismissed)return;
                committing=true;form.setAttribute("aria-busy","true");
                controls=Array.from(form.querySelectorAll("input,textarea,select,button"),control=>[control,control.disabled]);
                for(const[control]of controls)control.disabled=true;
                const saved=await this.client.request("/save",{...item,revision:item.revision||0,name:name.value,notes:notes.value,architecture:architecture.value,category:category.value,disabled:disabled.checked,cover},BASE+"/models");
                for(const [k,m] of Object.entries(this.state.modules))if(item.kind===k&&m.files.includes(item.file)){m.name=saved.name;m.cover=saved.cover;m.file_names=m.files.map((f,i)=>f===item.file?saved.name:(m.file_names?.[i]||f.split(/[\\/]/).pop()));if(k==="model")m.architecture=saved.architecture||"";}
                committing=false;close();if(!this.closed){this.notify("公共模型资料已保存，工作流选择需点击应用。");this.changed();if(this.tab==="models")await this.loadModels();}
            }catch(e){if(!dismissed)error.textContent=e.message;}
            finally{committing=false;for(const[control,disabled]of controls)control.disabled=disabled;save.disabled=false;form.removeAttribute("aria-busy");}
        });
        dialog.append(form);document.body.append(dialog);dialog.showModal();name.focus();
    }
    loras(){
        if(!this.state.lora.enabled)this.body.append(el("p","um-muted","LoRA 功能已关闭，仍可编辑并保存选择，开启后恢复。"));
        const mount=el("div","um-lora-mount");this.body.append(mount);
        const lc=new LoRAClient((url,opts)=>this.client.fetcher(url,opts),key=>this.client.imageURL("/loras",key));
        this.loraManager=new LoRAManager({mount,client:lc,getConfig:()=>JSON.stringify({version:1,entries:this.state.lora.entries,preset:this.state.lora.preset}),hasClip:()=>this.state.modules.clip.source!=="off",setConfig:raw=>{const v=JSON.parse(raw);this.state.lora.entries=v.entries;this.state.lora.preset=v.preset;this.changed();}});
    }
    async presets(){
        const token=++this.serial,items=await this.client.request("/presets");if(this.closed||this.tab!=="presets"||token!==this.serial)return;
        this.body.append(el("h2","","完整预设"),el("p","um-muted","保存整套模型、来源、功能开关和全部 LoRA 配置。选择后仍需点击应用到节点。"));const grid=el("div","um-grid");
        for(const p of items){const card=el("article","um-card"),cover=el("div","um-cover");this.cover(cover,p.cover||p.state.modules.model.cover,p.cover?"":"/models");card.append(cover,el("strong","",p.name),el("small","um-note um-muted",p.notes||"暂无备注"),button("选择预设",()=>this.run(async()=>{if(!await confirmDialog(`用“${p.name}”替换当前窗口中的整套配置？外部组件仍需连接相应输入。`))return;const result=await this.client.request("/apply-preset",{id:p.id});this.state=parseState(result.state);this.changed();this.notify(`已选择“${p.name}”，点击应用到节点生效。`);} ),"um-primary"),button("编辑",()=>this.run(()=>this.editPreset(p))),button("删除",()=>this.run(async()=>{if(await confirmDialog(`删除“${p.name}”？已有工作流快照仍保留。`)){await this.client.request("/delete-preset",{id:p.id,revision:p.revision});this.showTab("presets");}})));grid.append(card);}
        if(!items.length)grid.append(el("p","um-muted","还没有完整预设，配置好后点击底部“保存预设”。"));this.body.append(grid);
    }
    async editPreset(p){
        const dialog=el("dialog","um-confirm um-preset-editor");dialog.setAttribute("aria-label","编辑完整预设");
        const name=input(p.name),notes=el("textarea"),error=el("p","um-error"),details=el("pre","um-pre um-muted");name.required=true;name.maxLength=256;notes.maxLength=32000;notes.value=p.notes||"";
        details.textContent=summary(parseState(p.state));error.setAttribute("role","alert");
        const form=el("form");form.append(el("h2","","编辑完整预设"),field("预设名称",name),field("备注",notes),el("strong","","已保存配置详情（只读）"),details,error);
        const finish=()=>{dialog.close();dialog.remove();};
        const actions=el("div","um-actions"),cancel=button("取消",finish),save=button("保存资料",()=>{},"um-primary");save.type="submit";actions.append(cancel,save);form.append(actions);
        form.addEventListener("submit",async event=>{event.preventDefault();save.disabled=true;error.textContent="";try{const result=await this.client.request("/edit-preset",{id:p.id,revision:p.revision,name:name.value,notes:notes.value});finish();this.notify(`“${result.name}”的名称和备注已保存。`);if(this.tab==="presets")this.showTab("presets");}catch(e){error.textContent=e.message;}finally{save.disabled=false;}});
        dialog.addEventListener("cancel",event=>{event.preventDefault();finish();});dialog.append(form);document.body.append(dialog);dialog.showModal();name.focus();
    }
    async savePreset(){
        const presets=await this.client.request("/presets"),linked=presets.find(p=>p.id===this.state.preset?.id),dialog=el("dialog","um-confirm"),name=input(this.state.name||linked?.name||""),notes=el("textarea"),file=input("","file"),error=el("p","um-error"),preview=el("div","um-detail-cover");
        notes.value=linked?.notes||"";name.maxLength=256;notes.maxLength=32000;file.accept="image/png,image/jpeg,image/webp";
        let cover=this.state.cover||linked?.cover||null,uploading=null,dismissed=false,committing=false,uploadSerial=0;
        this.cover(preview,cover||this.state.modules.model.cover,cover?"":"/models");
        const cancel=()=>{if(dismissed||committing)return;dismissed=true;uploadSerial++;dialog.close();dialog.remove();};
        file.addEventListener("change",()=>{if(!file.files[0])return;const serial=++uploadSerial;file.disabled=true;uploading=this.client.upload(file.files[0]).then(v=>{if(dismissed||serial!==uploadSerial)return;cover=v.cover;this.cover(preview,cover);}).catch(e=>{if(dismissed||serial!==uploadSerial)return;error.textContent=e.message;throw e;}).finally(()=>{if(serial===uploadSerial)file.disabled=false;});uploading.catch(()=>{});});
        dialog.append(el("h2","","保存完整预设"),el("p","um-pre",summary(this.state)),field("预设名称",name),field("备注",notes),preview,field("自定义封面（留空时使用主模型封面）",file),button("清除自定义封面",()=>{uploadSerial++;file.disabled=false;cover=null;this.cover(preview,null);}),error);
        const save=button("确认保存",async()=>{
            save.disabled=true;error.textContent="";
            try{
                if(uploading)await uploading;if(dismissed)return;
                const existing=presets.find(p=>p.name.toLocaleLowerCase()===name.value.trim().toLocaleLowerCase());
                if(existing&&!await confirmDialog(`覆盖预设“${existing.name}”？`))return;
                committing=true;
                const result=await this.client.request("/save-preset",{state:this.state,name:name.value,notes:notes.value,cover,...(existing?{id:existing.id,revision:existing.id===this.state.preset?.id?this.state.preset.revision:existing.revision}:{})});
                this.state=parseState(result.state);committing=false;cancel();this.changed();this.notify("完整预设已保存，点击应用到节点更新画布。");if(this.tab==="presets")this.showTab("presets");
            }catch(e){error.textContent=e.message;}finally{committing=false;save.disabled=false;}
        },"um-primary");
        dialog.append(button("取消",cancel),save);dialog.addEventListener("cancel",event=>{event.preventDefault();cancel();});document.body.append(dialog);dialog.showModal();
    }}
