![](VUEPort.webp?raw=true)

# VUEPort

VUEPort (read "viewport") is a modern, accurate and easy-to-use Virtual Boy Emulator for your browser and desktop, build arount the [Shrooms-VB](https://git.virtual-boy.com/PVB/shrooms-vb-core) core.

VUEPort was originally developed as the built-in emulator of [VUEngine Studio](https://www.vuengine.dev). This repository contains the core consumed by VUEngine Studio as well as standalone web and desktop versions.

## Packages

| Package | Description |
| --- | --- |
| `packages/core` (`vueport-core`) | The emulator itself: worker, panels, React components, i18n. Host-agnostic — everything platform-specific goes through the seams in `src/common/emulator-host.ts`. |

Planned: `packages/web` (standalone browser build) and `packages/desktop`
(native wrapper). Both consume `vueport-core`; neither is a dependency of it.


## License

This code is licensed under MIT. This does not cover shrooms-vb-core.