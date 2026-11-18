// static smoke test for the standalone VBC surfaces, which live in several files (title bar, status bar, palette,
// preferences, ROM info, VCU inspector), so losing one in a refactor fails loudly
import { readFileSync } from 'node:fs';

let failures = 0;
function expect(file, needles) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const needle of needles) {
        if (!source.includes(needle)) {
            failures++;
            console.log(`FAIL ${file} is missing ${needle}`);
        }
    }
}

function expectMissing(file, needles) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const needle of needles) {
        if (source.includes(needle)) {
            failures++;
            console.log(`FAIL ${file} still contains ${needle}`);
        }
    }
}

function expectOrderAfter(file, anchor, first, second) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const start = source.indexOf(anchor);
    const a = start < 0 ? -1 : source.indexOf(first, start);
    const b = start < 0 ? -1 : source.indexOf(second, start);
    if (start < 0 || a < 0 || b < 0 || a >= b) {
        failures++;
        console.log(`FAIL ${file} does not keep ${first} before ${second} after ${anchor}`);
    }
}

expect('../src/web-title-bar.tsx', [
    'vbcHeaderPillLabel',
    'vp-titlebar-vbc',
    'pickHardwareMode()',
]);
expect('../src/web-status-bar.tsx', [
    'HardwareItem',
    'hardwareModeStatusLabel',
    'vp-status-hardware',
    '<HardwareItem emulator={emulator} />',
]);
expect('../src/web-commands.ts', [
    'EmulatorCommands.TOGGLE_VBC_SUPPORT',
    'toggleVbcSupport()',
    'EmulatorCommands.SET_HARDWARE_MODE',
    'pickHardwareMode()',
    '...(emulator.vbcSupportEnabled ? [{',
]);
expect('../src/web-emulator.tsx', [
    'get vbcSupportEnabled()',
    'this.getRenderingMode() === VbRenderingMode.ANAGLYPH || this.vbcHardwareActive',
    "getPropertyValue('--vp-ambient-color')",
    'onDidChangeTheme(() => this.applyDecoration())',
    "return VbHardwareMode.VIRTUAL_BOY;",
    "'Enable VB Color Support?'",
    "await this.settings.set('vbcSupportEnabled', true)",
    'this.dock.setVbcSupportEnabled(this.vbcSupportEnabled, this.vbcHardwareActive)',
    "if (key === 'hardwareMode' || key === 'vbcSupportEnabled')",
    'this.link?.release()',
    'linkEnded',
]);
expect('../src/host-theme.css', [
    '--vp-ambient-color: #ffffff',
    '--vp-ambient-color: #9fa1ad',
]);
expectOrderAfter(
    '../src/web-emulator.tsx',
    'protected async onSettingChanged(key: string)',
    'this.link?.release()',
    'await this.stop()'
);
expect('../src/web-rom-info.tsx', [
    'emulator.vbcSupportEnabled',
    'romHeader.vbcSupport.toString(16)',
    "'VB Color'",
]);
expect('../../core/src/common/emulator-settings.ts', [
    'vbcSupportEnabled: boolean',
    'vbcSupportEnabled: true',
]);
expect('../../core/src/browser/emulator-settings-schema.ts', [
    'vbcSupportEnabled:',
    "type: 'boolean'",
    "'VB Color Support'",
]);
expect('../../core/src/browser/components/settings/VbColorSettings.tsx', [
    "useSetting(props.settings, 'vbcSupportEnabled')",
    "<SwitchSetting id='vbcSupportEnabled' />",
    "<ChoiceSetting id='hardwareMode' />",
]);
expect('../../core/src/browser/emulator-core-service.ts', [
    'await mirror.setHardwareMode(this.sim.isVbcHardware)',
]);
expect('../../core/wasm/shrooms/build-vbc.mjs', [
    '0x0307F800',
    '0x0307F804',
    'version !== 0x0100',
    'built core is not VBC 1.0',
]);
expect('../../core/src/browser/panels/emulator-vcu-memory.ts', [
    'VCU_CRAM_BASE = 0x03079000',
    'VCU_CRAM_COLORS = 1024',
    'VCU_REGISTER_BASE = 0x0307f800',
    'VBC_VERSION_VALUE = 0x0100',
]);
expect('../../core/src/browser/panels/emulator-vcu-panel.tsx', [
    'VcuPanel',
    'VBCID0',
    'COLCTRL',
    'LNKCTRL',
    'CXCTRL',
    'DMACTRL',
    'VCU_CRAM_BASE',
    'VCU_CRAM_COLORS',
    'vp-vcu-cram-color',
    'vbColorSupportLabel',
    'this.source.vbcSupportEnabled',
]);
expectMissing('../../core/src/browser/panels/emulator-registers-panel.tsx', ['VcuRegister', 'renderVcu']);
// the one VB Color surface outside the VCU panel: the aperture as a jump target, only while a VB Color runs
expect('../../core/src/browser/panels/emulator-memory-panel.tsx', [
    'VCU_MEMORY_REGION',
    'this.source.vbcHardwareActive',
]);
expectMissing('../../core/src/browser/panels/emulator-rom-info-panel.tsx', ['romHeader.vbcSupport']);
expect('../../core/src/browser/panels/emulator-panel.ts', [
    "VCU = 'vcu'",
    'readonly vbcSupportEnabled: boolean',
    // narrower than the gate above: what every color-only surface keys off
    'readonly vbcHardwareActive: boolean',
]);
expect('../../core/src/browser/panels/emulator-dock.ts', [
    'setVbcSupportEnabled(enabled: boolean, hardwareActive',
    'new VcuPanel',
]);
// the VCU panel opens on any machine and says which machine is running (see its render)
expectMissing('../../core/src/browser/panels/emulator-dock.ts', [
    'kind === EmulatorPanelType.VCU && !this.vbcHardwareActive',
]);
expect('../../core/src/browser/panels/emulator-vcu-panel.tsx', [
    'vueport/debug/panels/vcu/notColorMode',
    'vueport/debug/panels/vcu/supportOff',
]);

console.log(failures === 0 ? 'VBC UI probe PASS' : `${failures} VBC UI check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
