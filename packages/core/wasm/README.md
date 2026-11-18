# `wasm/`

Two WebAssembly modules, committed as prebuilt binaries, since neither this package nor CI carries the toolchains.

```
wasm/
  shrooms/
    core.wasm         the Virtual Boy and VB Color core
    build-vbc.mjs     rebuilds and installs it
  rcheevos/
    rcheevos.js       the RetroAchievements engine
    rcheevos.wasm
    build.mjs         rebuilds the two above
    smoke.mjs         exercises the engine under Node
    shim/             the C between rc_client and vb-rcheevos.ts
    upstream/         rcheevos source, fetched by build.mjs, not in git
```

## Shrooms-VB Core

`core.wasm` is the [Shrooms-VB](https://git.virtual-boy.com/PVB/shrooms-vb-core) core with VB Color 1.0 support. Its sources are not in this repository.

## RetroAchievements Engine

`rcheevos.js` and `rcheevos.wasm` are upstream [rcheevos](https://github.com/RetroAchievements/rcheevos)' `rc_client`, compiled together with `shim/vueport-rc.c`. The worker loads them in `packages/core/src/worker/vb-rcheevos.ts`.

### Testing

```sh
node packages/core/wasm/rcheevos/smoke.mjs
yarn workspace vueport-web build
node packages/web/tests/retroachievements-probe.mjs
node packages/web/tests/leaderboards-probe.mjs
```

All three use canned server responses. Testing against the live server needs a registered client and real credentials (see `RETROACHIEVEMENTS_CLIENT` in `packages/core/src/common/vb-constants.ts`).

### Hardcore and Leaderboards

`rc_client` starts in hardcore mode. `vrc_create` switches it off, and `vrc_set_hardcore` switches it back on for a player who asks for it. Leaderboard lists and entries work in either mode, but `rc_client` only runs a leaderboard attempt in hardcore, which is RetroAchievements' own rule. The internal `allow_leaderboards_in_softcore` is left alone on purpose.

> **Note**: The server answers `unsupported_client` until RetroAchievements registers the VUEPort client (`RETROACHIEVEMENTS_CLIENT`). Registration turns everything on without code changes.
