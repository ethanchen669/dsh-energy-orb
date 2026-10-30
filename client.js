// Client 半边占位（Task 5 实现 OrbClient；当前注册空工厂，保证 bundle 完整可装）
window.__ModuleLoader__.load({
  id: 'dsh-energy-orb',
  factory(require) {
    return {
      inject: ['slots'],
      apply() {},
    };
  },
});
