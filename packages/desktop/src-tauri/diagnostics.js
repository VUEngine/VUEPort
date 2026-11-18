// injected before the page's own scripts to report on the webview VUEPort actually runs in. Changes nothing: it reads
// capabilities, watches the status bar and draws a panel in the corner. Each check decides whether a system webview
// can host the emulator, as something VUEPort depends on and would fail on quietly
(function () {
    'use strict';

    // the rate the emulator asks its AudioContext for, from VB_SAMPLE_RATE
    var WANTED_RATE = 41700;
    // stereo frames in one buffer, from VB_SAMPLES_PER_BUFFER
    var FRAMES_PER_BUFFER = 834;
    // emulated frames a second at full speed, from VB_FRAME_RATE
    var FRAME_RATE = 50;

    var results = [];
    var panel;
    var rows = {};

    function add(id, label) {
        results.push({ id: id, label: label, state: 'run', note: '' });
        return id;
    }

    function set(id, state, note) {
        for (var i = 0; i < results.length; i++) {
            if (results[i].id === id) {
                results[i].state = state;
                results[i].note = note || '';
            }
        }
        render();
    }

    var report;

    add('app', 'VUEPort renders');
    add('audio', 'Audio clock (41700 Hz)');
    add('webglmain', 'WebGL2 on the main thread');
    add('webgl', 'WebGL2 in a worker');
    add('secure', 'Secure context');
    add('opfs', 'Origin private file system');
    add('inflate', 'DecompressionStream deflate-raw');
    add('storage', 'Native storage');
    add('rumble', 'Rumble Pack port');
    add('guard', 'Opened-file guard');
    add('beside', 'Files beside the ROM');
    add('essound', 'ESSound tracks');
    add('symbols', 'ROM symbols');
    add('title', 'Window title');
    add('speed', 'Emulated speed');
    add('link', 'BroadcastChannel between windows');
    add('session', 'Linked session');

    function render() {
        if (!panel) {
            return;
        }
        for (var i = 0; i < results.length; i++) {
            var result = results[i];
            var row = rows[result.id];
            if (!row) {
                continue;
            }
            row.mark.textContent = result.state === 'pass' ? '✓'
                : result.state === 'fail' ? '✗'
                    : result.state === 'warn' ? '!' : '…';
            row.mark.style.color = result.state === 'pass' ? '#5dbe39'
                : result.state === 'fail' ? '#e03030'
                    : result.state === 'warn' ? '#e0a020' : '#888';
            row.note.textContent = result.note;
        }
    }

    function build() {
        panel = document.createElement('div');
        panel.setAttribute('data-vueport-smoke-test', '');
        setStyle(panel, {
            position: 'fixed', top: '8px', right: '8px', zIndex: '2147483647',
            background: 'rgba(20,20,24,0.94)', color: '#e6e6ea',
            border: '1px solid #35353d', borderRadius: '6px',
            font: '12px/1.5 ui-monospace, Menlo, monospace',
            padding: '8px 10px', minWidth: '300px', maxWidth: '420px',
            boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
        });

        var head = document.createElement('div');
        setStyle(head, { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' });
        var title = document.createElement('b');
        title.textContent = 'Tauri smoke test';
        var close = document.createElement('button');
        close.textContent = '✕';
        setStyle(close, {
            background: 'none', border: 'none', color: '#888',
            cursor: 'pointer', font: 'inherit', padding: '0 2px',
        });
        close.onclick = function () { panel.remove(); panel = undefined; };
        head.appendChild(title);
        head.appendChild(close);
        panel.appendChild(head);

        for (var i = 0; i < results.length; i++) {
            var result = results[i];
            var row = document.createElement('div');
            setStyle(row, { display: 'flex', gap: '6px', alignItems: 'baseline' });
            var mark = document.createElement('span');
            setStyle(mark, { width: '1em', flex: 'none' });
            var label = document.createElement('span');
            label.textContent = result.label;
            setStyle(label, { flex: 'none' });
            var note = document.createElement('span');
            setStyle(note, { opacity: '0.7', marginLeft: 'auto', textAlign: 'right' });
            row.appendChild(mark);
            row.appendChild(label);
            row.appendChild(note);
            panel.appendChild(row);
            rows[result.id] = { mark: mark, note: note };
        }

        var hint = document.createElement('div');
        hint.textContent = 'Open a ROM to check the speed.';
        setStyle(hint, { opacity: '0.5', marginTop: '6px' });
        panel.appendChild(hint);

        document.body.appendChild(panel);
        render();
    }

    function setStyle(node, style) {
        for (var key in style) {
            if (Object.prototype.hasOwnProperty.call(style, key)) {
                node.style[key] = style[key];
            }
        }
    }

    // the one that fails silently: a webview ignoring AudioContextOptions.sampleRate does not throw, but the audio clock
    // paces emulation, so the machine runs at the wrong speed with pitched audio, which looks like an emulator bug
    function checkAudio() {
        var context;
        try {
            context = new AudioContext({ latencyHint: 'interactive', sampleRate: WANTED_RATE });
        } catch (error) {
            set('audio', 'fail', 'refused: ' + error);
            return;
        }
        var rate = context.sampleRate;
        try { context.close(); } catch (ignored) { } // closing is best-effort

        if (rate === WANTED_RATE) {
            set('audio', 'pass', rate + ' Hz');
            return;
        }
        // emulated seconds per wall second, if the rate is not honored
        var ratio = rate / (FRAME_RATE * FRAMES_PER_BUFFER);
        set('audio', 'fail', rate + ' Hz → ' + Math.round(ratio * 100) + '% speed');
    }


    // without a worker, to tell the check below apart: if only this works, the webview lacks WebGL in workers; if neither
    // works there is no usable GL at all (on a virtual framebuffer, that says more about the framebuffer)
    function checkMainWebgl() {
        try {
            var canvas = document.createElement('canvas');
            var gl = canvas.getContext('webgl2');
            if (gl) {
                set('webglmain', 'pass', String(gl.getParameter(gl.VERSION)).slice(0, 30));
                return;
            }
            set('webglmain', 'fail', canvas.getContext('webgl') ? 'WebGL1 only' : 'no context');
        } catch (error) {
            set('webglmain', 'fail', String(error).slice(0, 40));
        }
    }

    // VUEPort normally transfers the canvas to the worker and draws with WebGL2 there; the Linux desktop transfers packed
    // frames to the page instead when this context is unavailable
    function checkWorkerWebgl() {
        // runs as soon as the worker starts rather than waiting to be asked, as a handshake is one more reason for silence
        var source = '(function(){'
            + 'if(typeof OffscreenCanvas!=="function"){postMessage("no OffscreenCanvas");return;}'
            + 'try{'
            + 'var c=new OffscreenCanvas(8,8);'
            + 'var gl=c.getContext("webgl2");'
            + 'if(gl){postMessage("ok:"+(gl.getParameter(gl.VERSION)||"webgl2"));return;}'
            + 'postMessage(c.getContext("webgl")?"WebGL1 only":"no context");'
            + '}catch(e){postMessage("threw: "+e);}'
            + '}());';
        var worker;
        try {
            worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        } catch (error) {
            set('webgl', 'warn', 'could not start a worker: ' + error);
            return;
        }
        var settled = false;
        var timer = setTimeout(function () {
            if (!settled) {
                settled = true;
                set('webgl', 'fail', 'no answer from the worker');
                worker.terminate();
            }
        }, 5000);
        worker.onerror = function (event) {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            set('webgl', 'fail', 'worker failed: ' + ((event && event.message) || 'unknown'));
            worker.terminate();
        };
        worker.onmessage = function (event) {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            var answer = String(event.data);
            if (answer.indexOf('ok:') === 0) {
                set('webgl', 'pass', answer.slice(3).slice(0, 28));
            } else {
                // WebKitGTK has page WebGL2 but no worker WebGL; the Linux desktop deliberately sends packed frames to the page renderer
                var fallback = /Linux/.test(navigator.userAgent)
                    && typeof shellInvoke() === 'function';
                set('webgl', fallback ? 'warn' : 'fail', fallback
                    ? 'main-thread renderer: ' + answer.slice(0, 18)
                    : answer.slice(0, 40));
            }
            worker.terminate();
        };
    }

    // navigator.storage is gated on it, so this tells "this webview cannot" from "this webview was not asked properly"
    // when the check below reports a missing API
    function checkSecureContext() {
        var origin = (window.location && window.location.origin) || 'unknown';
        if (window.isSecureContext) {
            set('secure', 'pass', origin);
        } else {
            set('secure', 'fail', 'not secure: ' + origin);
        }
    }

    // what a linked two-player session is built on: each window runs both machines and they exchange a controller mask a
    // frame over a BroadcastChannel; decides whether the desktop shell has to relay. Only meaningful with a second window,
    // which VUEPORT_LINK_PROBE arranges (see link.rs)
    function checkLink() {
        if (typeof BroadcastChannel !== 'function') {
            set('link', 'fail', 'no BroadcastChannel');
            return;
        }
        var label = windowLabel();
        var channel = new BroadcastChannel('vueport.smoke.link');
        var heard = false;
        channel.onmessage = function (event) {
            if (!event.data || event.data.from === label) {
                return;
            }
            heard = true;
            set('link', 'pass', 'heard ' + String(event.data.from).slice(0, 20));
            render();
        };
        // said repeatedly, as the other window may not exist yet and a message nobody hears looks like one never sent
        setInterval(function () {
            try {
                channel.postMessage({ from: label });
            } catch (ignored) {
                // a closed window is not a failure of the channel
            }
            if (!heard) {
                set('link', 'warn', 'alone as "' + label + '"');
                render();
            }
        }, 500);
    }

    // the row above says the windows can hear each other, this one that a session got that far, read off the badge the
    // title bar shows only while a session is up
    function watchSession() {
        setInterval(function () {
            var badge = document.querySelector('.vp-titlebar-pill.linked');
            if (badge) {
                set('session', 'pass', (badge.textContent || '').trim().slice(0, 24));
            } else {
                set('session', 'run', 'not linked');
            }
            render();
        }, 500);
    }

    // for the checks that must not collide with another window; a browser has none and needs none
    function windowLabel() {
        try {
            var current = window.__TAURI__
                && window.__TAURI__.window
                && window.__TAURI__.window.getCurrentWindow
                && window.__TAURI__.window.getCurrentWindow();
            if (current && current.label) {
                return String(current.label);
            }
        } catch (ignored) {
            // not a Tauri window
        }
        return 'main';
    }

    // where every save, save state and unpacked ESSound track lives
    function checkOpfs() {
        if (!navigator.storage) {
            set('opfs', 'fail', 'no navigator.storage');
            return;
        }
        if (!navigator.storage.getDirectory) {
            set('opfs', 'fail', 'no getDirectory');
            return;
        }
        navigator.storage.getDirectory().then(function (root) {
            var name = 'vueport-smoke-test.' + windowLabel();
            return root.getFileHandle(name, { create: true })
                .then(function (handle) {
                    return handle.createWritable().then(function (writable) {
                        return writable.write(new Uint8Array([1, 2, 3, 4]))
                            .then(function () { return writable.close(); });
                    }).then(function () {
                        return handle.getFile();
                    }).then(function (file) {
                        return file.arrayBuffer();
                    }).then(function (buffer) {
                        var ok = buffer.byteLength === 4;
                        set('opfs', ok ? 'pass' : 'fail', ok ? 'read back 4 bytes' : 'wrote 4, read ' + buffer.byteLength);
                        return root.removeEntry(name);
                    });
                });
        }).catch(function (error) {
            set('opfs', 'fail', String(error).slice(0, 40));
        });
    }

    // what unpacks a zipped ROM, with no library behind it to fall back on
    function checkInflate() {
        try {
            /* eslint-disable-next-line no-new */
            new DecompressionStream('deflate-raw');
            set('inflate', 'pass', 'available');
        } catch (error) {
            set('inflate', 'fail', 'not implemented');
        }
    }

    // sends the findings somewhere when the Rust side sets __VUEPORT_SMOKE_REPORT from an environment variable. Failures
    // are ignored, as the panel is the primary answer
    report = function () {
        var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
        if (typeof invoke !== 'function') {
            return;
        }
        try {
            invoke('smoke_report', {
                payload: JSON.stringify({ userAgent: navigator.userAgent, results: results }),
            }).catch(function () { }); // nothing listening is fine
        } catch (ignored) {
            // nothing listening is fine
        }
    };

    // the application's own chrome is the evidence: React renders the toolbar and status bar on start-up with or without
    // a ROM, so a webview that loaded the page but could not run it shows neither
    function watchApp() {
        var toolbar = document.querySelector('.vp-toolbar');
        var status = document.querySelector('.vp-status');
        if (toolbar && status) {
            set('app', 'pass', 'toolbar and status bar are up');
        } else if (document.querySelector('#root, #vp-root')) {
            set('app', 'run', 'mounting');
        } else {
            // the application replaces the body with a message when start-up throws, the most useful thing to report
            var text = (document.body && document.body.textContent || '').trim();
            set('app', 'fail', text ? text.slice(0, 90) : 'nothing rendered');
        }
    }

    // read off the status strip rather than computed; the Speed entry is found by the shape of its value, as the
    // label is translated
    function watchSpeed() {
        setInterval(function () {
            watchApp();
            var items = document.querySelectorAll('.vp-status-item');
            var reading;
            for (var i = 0; i < items.length; i++) {
                var value = items[i].querySelector('.vp-status-value');
                var text = value ? value.textContent.trim() : '';
                if (/^[\d.]+%$/.test(text) || /^[\d.]+x$/.test(text)) {
                    reading = text;
                }
            }
            if (!reading) {
                set('speed', 'run', 'waiting for a ROM');
                return;
            }
            var percent = parseFloat(reading);
            if (reading.slice(-1) === 'x') {
                percent = percent * 100;
            }
            if (percent >= 90 && percent <= 110) {
                set('speed', 'pass', reading);
            } else {
                set('speed', 'fail', reading + ' — should be ~100%');
            }
        }, 1000);
        // same cadence: whatever has settled by now goes out with it
        setInterval(report, 1000);
    }

    // undefined in a browser
    function shellInvoke() {
        return window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    }

    // a round trip through the shell's storage commands (written, read back, listed, removed), which saves and save states
    // go through in a packaged build
    function checkStorage() {
        var invoke = shellInvoke();
        if (typeof invoke !== 'function') {
            set('storage', 'warn', 'desktop only');
            return;
        }
        var path = 'diagnostics/round-trip.bin';
        var wrote = [1, 2, 3, 4, 5];
        // the bytes as the body and the path in a header, as the application writes files (see storage_write)
        invoke('storage_write', new Uint8Array(wrote),
            { headers: { 'x-vueport-path': encodeURIComponent(path) } })
            .then(function () { return invoke('storage_read', { path: path }); })
            .then(function (read) {
                // raw bytes, so an ArrayBuffer rather than an array of numbers, as storage_read hands files over as they stand
                var length = read instanceof ArrayBuffer ? read.byteLength
                    : read && read.length !== undefined ? read.length : -1;
                if (length !== wrote.length) {
                    throw new Error('read back ' + length + ' of ' + wrote.length);
                }
                return invoke('storage_list', { directory: 'diagnostics' });
            })
            .then(function (files) {
                if (!files || files.length === 0) {
                    throw new Error('the directory listed empty');
                }
                return invoke('storage_delete', { path: 'diagnostics' });
            })
            .then(function () { return invoke('storage_root'); })
            .then(function (root) { set('storage', 'pass', String(root)); })
            .catch(function (error) { set('storage', 'fail', String(error).slice(0, 60)); });
    }

    // no pack attached is a pass: the check is that the shell can look, not that hardware is present
    function checkRumble() {
        var invoke = shellInvoke();
        if (typeof invoke !== 'function') {
            set('rumble', 'warn', 'desktop only');
            return;
        }
        invoke('rumble_ports')
            .then(function (ports) {
                var count = ports ? ports.length : 0;
                set('rumble', 'pass', count === 0
                    ? 'none attached'
                    : count + ' attached: ' + ports.map(function (p) { return p.name; }).join(', '));
            })
            .catch(function (error) { set('rumble', 'fail', String(error).slice(0, 60)); });
    }

    // the shell only reads back paths it was given itself; anything else must be refused, or it would read the whole disk
    function checkOpenGuard() {
        var invoke = shellInvoke();
        if (typeof invoke !== 'function') {
            set('guard', 'warn', 'desktop only');
            return;
        }
        invoke('read_opened_file', { path: '/etc/hosts' })
            .then(function () { set('guard', 'fail', 'read a file it was never given'); })
            .catch(function () { set('guard', 'pass', 'refuses a path it was not given'); });
    }

    /**
     * The other half of `guard`, which failed quietly: a shell refusing the ROM's own folder looks like a ROM with
     * nothing beside it, while the ESSound tracks and the .elf behind the debugger's symbols live there. So this asks
     * the app's three calls when a ROM starts:
     *
     *   files=n   the ROM's folder can be listed at all
     *   map=yes   `<rom>.map` reads through read_rom_build_file
     *   elf=yes   so does the image the map declares, which a VUEngine build leaves a folder away in build/working
     */
    function checkBesideRom() {
        var invoke = shellInvoke();
        if (typeof invoke !== 'function') {
            set('beside', 'warn', 'desktop only');
            return;
        }
        invoke('opened_paths').then(function (paths) {
            var rom = paths && paths.length ? paths[0] : undefined;
            if (!rom) {
                set('beside', 'warn', 'no ROM opened');
                return;
            }
            var directory = rom.replace(/[\\/][^\\/]*$/, '');
            var stem = rom.split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
            var note = '';
            invoke('storage_list', { directory: directory })
                .then(function (files) {
                    note = 'files=' + (files ? files.length : 0);
                    return invoke('read_rom_build_file', { rom: rom, relative: stem + '.map' });
                })
                .then(function (map) {
                    note += ' map=yes';
                    // relative to the folder the build ran in, one up from the ROM
                    var declared = /OUTPUT\(([^\s)]+)/.exec(text(map));
                    return declared
                        ? invoke('read_rom_build_file', { rom: rom, relative: declared[1] })
                        : Promise.reject(new Error('no OUTPUT line'));
                })
                .then(function () { set('beside', 'pass', note + ' elf=yes'); })
                .catch(function (error) {
                    // a ROM not built with VUEngine has no map and no image, which is not the shell's failure; only an unlistable folder is
                    set('beside', note ? 'pass' : 'fail', note
                        ? note + ' ' + String(error).slice(0, 40)
                        : String(error).slice(0, 60));
                });
        }).catch(function (error) { set('beside', 'fail', String(error).slice(0, 60)); });
    }

    // what came of `beside`: the tracks found beside the ROM and whether the build's symbols were read, found by
    // data-status rather than translated labels. Symbols are a Debug-mode reading, so in Play mode it stays a warning
    function watchRom() {
        setInterval(function () {
            // the strip's own words: `…` is "not looked yet", `—` is "looked, and there is nothing"
            var essound = raw('esSound');
            var symbols = reading('symbols');
            set('essound',
                essound === '' || essound === '…' ? 'run' : /track/.test(essound) ? 'pass' : 'warn',
                essound === '' ? 'waiting for a ROM' : essound);
            set('symbols', symbols === undefined ? 'warn' : /\d/.test(symbols) ? 'pass' : 'warn',
                symbols === undefined ? 'debug mode only' : symbols);
        }, 1000);
    }

    function raw(id) {
        var item = document.querySelector('.vp-status-item[data-status="' + id + '"]');
        var value = item && item.querySelector('.vp-status-value');
        return value ? value.textContent.trim() : '';
    }

    // with the strip's own ways of saying "nothing" left out
    function reading(id) {
        var text = raw(id);
        return text === '' || text === '—' || text === '…' ? undefined : text;
    }

    function text(answer) {
        if (typeof answer === 'string') {
            return answer;
        }
        var bytes = answer instanceof ArrayBuffer ? new Uint8Array(answer)
            : answer instanceof Uint8Array ? answer
                : new Uint8Array(answer || []);
        return new TextDecoder().decode(bytes);
    }

    function watchTitle() {
        var api = window.__TAURI__ && window.__TAURI__.window;
        if (!api || typeof api.getCurrentWindow !== 'function') {
            set('title', 'warn', 'desktop only');
            return;
        }
        setInterval(function () {
            try {
                api.getCurrentWindow().title().then(function (title) {
                    set('title', /VUEPort/.test(title) ? 'pass' : 'fail', title);
                }).catch(function (error) { set('title', 'fail', String(error).slice(0, 50)); });
            } catch (error) {
                set('title', 'fail', String(error).slice(0, 50));
            }
        }, 1000);
    }

    function start() {
        build();
        // sent straight away, so a silent run means the page never loaded rather than the checks never settling
        report();
        checkAudio();
        checkMainWebgl();
        checkWorkerWebgl();
        checkSecureContext();
        checkStorage();
        checkRumble();
        checkOpenGuard();
        checkBesideRom();
        watchRom();
        watchTitle();
        checkOpfs();
        checkInflate();
        checkLink();
        watchSession();
        watchSpeed();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
}());
