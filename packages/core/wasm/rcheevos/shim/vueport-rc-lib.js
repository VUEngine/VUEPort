/**
 * The JavaScript half of vueport-rc.c's three host hooks, linked in with Emscripten's --js-library (see ../build.mjs).
 * Each function only decodes wasm-side arguments (a UTF-8 pointer, a byte buffer) into plain JS values and forwards
 * them to what vb-rcheevos.ts set on the module instance before any of this runs (vrcReadMemory, vrcServerCall,
 * vrcEmit; see ensureLoaded there). `Module` is that same instance, as Emscripten's MODULARIZE output gives all library
 * code a closure over the module it was compiled into.
 */
mergeInto(LibraryManager.library, {
    // reads up to numBytes of the emulated address space into the wasm heap and returns how many were read, as
    // rc_client_read_memory_func_t does
    vrc_read_memory: function (address, buffer, numBytes) {
        if (typeof Module.vrcReadMemory !== 'function') {
            return 0;
        }
        return Module.vrcReadMemory(address >>> 0, buffer, numBytes >>> 0) >>> 0;
    },

    // postData and contentType are null pointers for a GET, as with rc_api_request_t
    vrc_server_call: function (requestId, methodPtr, urlPtr, postDataPtr, contentTypePtr) {
        if (typeof Module.vrcServerCall !== 'function') {
            return;
        }
        Module.vrcServerCall(
            requestId,
            UTF8ToString(methodPtr),
            UTF8ToString(urlPtr),
            postDataPtr ? UTF8ToString(postDataPtr) : undefined,
            contentTypePtr ? UTF8ToString(contentTypePtr) : undefined,
        );
    },

    vrc_emit: function (jsonPtr) {
        if (typeof Module.vrcEmit !== 'function') {
            return;
        }
        Module.vrcEmit(UTF8ToString(jsonPtr));
    },
});
