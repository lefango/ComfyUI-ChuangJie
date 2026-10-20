export function withLivePreviewOptions(options = {}) {
  return {
    ...(options || {}),
    // Current ComfyUI Frontend queuePrompt options use camelCase here.
    // Keep extra_data as well for the legacy frontend bundled by older builds.
    previewMethod: "auto",
    extra_data: {
      ...(options?.extra_data || {}),
      preview_method: "auto",
    },
  };
}

export function samplerPreviewBelongsToNode(detail, { samplerNodeId, samplePreviewNodeId, jobId } = {}) {
  if (!detail || samplerNodeId == null || jobId == null || !(detail.blob instanceof Blob)) return false;
  if (detail.jobId == null || String(detail.jobId) !== String(jobId)) return false;
  const sourceNodeId = detail.realNodeId ?? detail.nodeId;
  if (sourceNodeId != null) return String(sourceNodeId) === String(samplerNodeId);
  if (detail.displayNodeId == null) return false;
  const ownedPreviewNodeIds = new Set(
    [samplerNodeId, samplePreviewNodeId].filter((nodeId) => nodeId != null).map(String),
  );
  return ownedPreviewNodeIds.has(String(detail.displayNodeId));
}
