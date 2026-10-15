// Bundled into the test page so the browser runs the same client code.
import * as client from "./client.ts";
(globalThis as any).SmartImagingClient = client;
