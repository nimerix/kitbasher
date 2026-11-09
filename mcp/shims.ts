import { DOMParser } from 'linkedom';

// Browser APIs that Three's loaders and exporters call outside a browser. Importing this first
// lets the app's own import and export code run unchanged in Node.
const scope = globalThis as unknown as Record<string, unknown>;

scope.self ??= globalThis;
scope.DOMParser ??= DOMParser;

// Kitbasher discards texture maps on import, so an embedded image only has to decode to something.
scope.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });

class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  private finish(read: Promise<ArrayBuffer | string>) {
    read.then(
      (result) => {
        this.result = result;
        this.onload?.();
        this.onloadend?.();
      },
      (error) => this.onerror?.(error),
    );
  }

  readAsArrayBuffer(blob: Blob) {
    this.finish(blob.arrayBuffer());
  }

  readAsDataURL(blob: Blob) {
    this.finish(
      blob
        .arrayBuffer()
        .then(
          (data) =>
            `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(data).toString('base64')}`,
        ),
    );
  }
}
scope.FileReader ??= NodeFileReader;
