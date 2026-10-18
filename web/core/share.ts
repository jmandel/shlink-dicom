// openShare(): the whole receive path in one call: resolve the link, decrypt the Bundle, index it,
// and set up the loader. Experiences that need finer control use the parts directly.
import type { StudyIndex } from "./bundle";
import { WebCryptoDecryptor, type RecordDecryptor } from "./decrypt";
import { InstanceLoader, type LoaderOptions } from "./loader";
import { LinkResolver, type ResolverOptions } from "./resolver";
import type { ReadAdmission } from "./read-admission";

export interface OpenShareOptions extends ResolverOptions, LoaderOptions {
  passcode?: string;
  /** Where records are decrypted: WebCryptoDecryptor (this thread, the default) or PoolDecryptor (images.ts: the decoder workers). */
  decryptor?: RecordDecryptor;
}

export interface OpenShare {
  admission?: ReadAdmission;
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
 * Throws InvalidLinkError, PasscodeError, LinkError, or InvalidBundleError.
 */
export async function openShare(link: string | LinkResolver, o: OpenShareOptions = {}): Promise<OpenShare> {
  const t0 = performance.now();
  const resolver = typeof link === "string" ? await LinkResolver.fromLink(link, o) : link;
  const opened = await resolver.open(o.passcode);
  const index = opened.index;
  const decryptor = o.decryptor ?? new WebCryptoDecryptor();
  const loader = new InstanceLoader(resolver, decryptor, o);
  return { resolver, index, decryptor, loader, admission: o.admission, bundleBytes: opened.bundleBytes, openMs: performance.now() - t0 };
}
