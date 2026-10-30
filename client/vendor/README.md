# vendored: three

- **Package:** `three@0.170.0`（MIT License, Copyright © 2010-2024 three.js authors）
- **File:** `three.module.min.js`（`node_modules/three/build/three.module.min.js` 原样拷贝，未改动）
- **用途:** OrbRenderer 的 3D 管线（ADR-0001 / ADR-0004），由 client 半边经 `/energy-orb/assets/three.module.min.js` 动态 import 懒加载。
- **更新方式:** 改版本号时重新拷贝并更新本文件；`test/` 断言此处版本与 `client/vendor/three.module.min.js` 存在。
