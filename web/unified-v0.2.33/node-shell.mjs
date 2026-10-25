const NODE_CLASS = "CJUnifiedModelLoaderTest";
const selectionBindings = new WeakMap();

function isTargetDefinition(definition) {
    return definition?.name === NODE_CLASS || definition?.comfyClass === NODE_CLASS;
}

function isTargetNode(node) {
    return node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS;
}

export function createConsoleShellHooks(LiteGraph = globalThis.LiteGraph) {
    const noTitle = LiteGraph?.NO_TITLE ?? 1;
    return {
        beforeRegisterNodeDef(nodeType, nodeData) {
            if (!nodeType || !isTargetDefinition(nodeData)) return;
            nodeType.title_mode = noTitle;
            nodeType.color = "transparent";
            nodeType.bgcolor = "transparent";
        },
        beforeRegisterVueAppNodeDefs(nodeDefs) {
            const nodeDef = nodeDefs?.find?.(isTargetDefinition);
            if (!nodeDef) return;
            nodeDef.titleMode = noTitle;
            nodeDef.color = "transparent";
            nodeDef.bgcolor = "transparent";
        },
    };
}

export function applyConsoleNodeInstanceShell(node, element) {
    if (!isTargetNode(node)) return false;

    node.color = "transparent";
    node.bgcolor = "transparent";
    node.strokeStyles ||= {};
    node.strokeStyles.selected = () => undefined;

    let binding = selectionBindings.get(node);
    if (!binding) {
        binding = { element };
        const originalSelected = node.onSelected;
        node.onSelected = function (...args) {
            const result = originalSelected?.apply(this, args);
            binding.element?.classList?.add("is-selected");
            return result;
        };
        const originalDeselected = node.onDeselected;
        node.onDeselected = function (...args) {
            const result = originalDeselected?.apply(this, args);
            binding.element?.classList?.remove("is-selected");
            return result;
        };
        selectionBindings.set(node, binding);
    } else {
        binding.element = element;
    }

    return true;
}
