// A collapsed parent hides every descendant without changing library selection.
export function orderedCategories(categories, scope, excluded = new Set(), collapsed = new Set()) {
    const children = new Map(), result = [], visited = new Set();
    for (const category of categories) {
        if (category.scope !== scope || excluded.has(category.id)) continue;
        const siblings = children.get(category.parent) || [];
        siblings.push(category); children.set(category.parent, siblings);
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.name.localeCompare(b.name));
    const visit = (parent, depth) => {
        for (const category of children.get(parent) || []) {
            if (visited.has(category.id)) continue;
            visited.add(category.id);
            result.push({ ...category, depth, hasChildren: !!children.get(category.id)?.length });
            if (!collapsed.has(category.id)) visit(category.id, depth + 1);
        }
    };
    visit(null, 0);
    return result;
}

export function readCollapsed(scope) {
    try {
        const value = JSON.parse(localStorage.getItem(`cj-unified-test:collapsed:v1:${scope}`) || "[]");
        return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
    } catch { return new Set(); }
}

export function writeCollapsed(scope, value) {
    try { localStorage.setItem(`cj-unified-test:collapsed:v1:${scope}`, JSON.stringify([...value])); }
    catch { /* Folder browsing remains usable when local preferences cannot be saved. */ }
}
