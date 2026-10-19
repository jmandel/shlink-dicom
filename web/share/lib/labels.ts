// One link label: encrypted in server state, decrypted by the owner before it goes in a SHLink.
import { b64urlDecode, b64urlEncode, fromUtf8, utf8 } from "../../core/b64";

export interface EncryptedLabel {
  v: 1;
  iv: string;
  ciphertext: string;
}

const context = (sid: string) => utf8(`shl-dicom link label v1:${sid}`);
const keyFor = (ownerKey: string, usage: KeyUsage) => crypto.subtle.importKey("raw", b64urlDecode(ownerKey), "AES-GCM", false, [usage]);

export async function encryptLabel(label: string | null, ownerKey: string, sid: string): Promise<EncryptedLabel | null> {
  const value = label?.trim() || null;
  if (value === null) return null;
  if (value.length > 80) throw new Error("Keep the link label to 80 characters or fewer.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: context(sid), tagLength: 128 },
    await keyFor(ownerKey, "encrypt"), utf8(value),
  );
  return { v: 1, iv: b64urlEncode(iv), ciphertext: b64urlEncode(new Uint8Array(ciphertext)) };
}

export async function decryptLabel(value: EncryptedLabel, ownerKey: string, sid: string): Promise<string> {
  if (value.v !== 1 || value.iv.length !== 16 || value.ciphertext.length > 448) throw new Error("Invalid encrypted link label.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlDecode(value.iv), additionalData: context(sid), tagLength: 128 },
    await keyFor(ownerKey, "decrypt"), b64urlDecode(value.ciphertext),
  );
  const label = fromUtf8(new Uint8Array(plain));
  if (label.length > 80) throw new Error("Invalid link label length.");
  return label;
}
