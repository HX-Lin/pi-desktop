/**
 * Node's @types/node web globals provide fetch/Request/Response but not the
 * BodyInit alias; supply it so the vendored provider can type request bodies.
 */
declare global {
  type BodyInit =
    | string
    | ArrayBuffer
    | NodeJS.ArrayBufferView
    | Blob
    | FormData
    | URLSearchParams
    | ReadableStream
    | Iterable<Uint8Array>
    | AsyncIterable<Uint8Array>
    | null;
}

export {};
