// openShare(): the whole receive path in one call: resolve the link, decrypt the Bundle, index it,
// and set up the loader. Experiences that need finer control use the parts directly.
import { parseStudyIndex, type StudyIndex } from "./bundle";
import { createDecryptor, type DecryptorKind, type RecordDecryptor } from "./decrypt";
import { InstanceLoader, type LoaderOptions } from "./loader";
import { LinkResolver, type ResolverOptions } from "./resolver";

export interface OpenShareOptions extends ResolverOptions, LoaderOptions {
  passcode?: string;
  decrypt?: DecryptorKind;
}

export interface OpenShare {
  resolver: LinkResolver;
  index: StudyIndex;
  decryptor: RecordDecryptor;
  loader: InstanceLoader;
  bundleBytes: Uint8Array;
  /** ms spent resolving + decrypting the Bundle. */
  openMs: number;
}

/**
 * Opens a link. Pass an existing resolver to retry with a passcode (it remembers attempts).
 * Throws PasscodeError, LinkError, or InvalidBundleError.
 */
export async function openShare(link: string | LinkResolver, o: OpenShareOptions = {}): Promise<OpenShare> {
  const t0 = performance.now();
  const resolver = typeof link === "string" ? new LinkResolver(link, o) : link;
  const opened = await resolver.open(o.passcode);
  const index = parseStudyIndex(opened.bundleBytes);
  const decryptor = await createDecryptor(o.decrypt ?? "webcrypto", opened.bundleBytes);
  const loader = new InstanceLoader(resolver, decryptor, o);
  return { resolver, index, decryptor, loader, bundleBytes: opened.bundleBytes, openMs: performance.now() - t0 };
}
