declare module 'seek-bzip' {
    interface Bunzip {
        decode(input: Uint8Array): Uint8Array;
    }

    const bunzip: Bunzip;
    export = bunzip;
}
