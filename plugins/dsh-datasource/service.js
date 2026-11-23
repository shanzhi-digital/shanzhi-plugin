export function createDatasourceService(current) {
  const annotations = () => {
    const value = current().annotations;
    if (!value) throw Object.assign(new Error('请安装支持数据标注的数据源插件，并完成管理库升级。'), { status: 503, publicMessage: '请安装支持数据标注的数据源插件，并完成管理库升级。' });
    return value;
  };
  return Object.freeze({
    version: 1,
    list: () => annotations().list(),
    catalog: sourceId => annotations().catalog(sourceId),
    action: input => annotations().action(input),
    aiSave: input => annotations().aiSave(input),
    bindSession: (sessionId, sourceId) => current().store.bindSession(sessionId, { sourceId, retired: false }),
    retireSession: sessionId => current().store.retireSession(sessionId),
    async assertSession(sessionId, sourceId) {
      const binding = await current().store.findBinding(sessionId);
      if (!binding || binding.retired || binding.sourceId !== sourceId) {
        throw Object.assign(new Error('标注会话已失效，请重新发起。'), { status: 409, publicMessage: '标注会话已失效，请重新发起。' });
      }
    },
  });
}
