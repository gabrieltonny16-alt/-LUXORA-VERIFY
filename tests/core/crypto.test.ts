import { describe, expect, it } from "vitest";
import { decryptValue, encryptValue, keyedFingerprint } from "../../src/core/crypto.js";

const secret = "unit-test-secret-with-at-least-32-bytes";

describe("destination cryptography", () => {
  it("encrypts and decrypts a destination", async () => {
    const encrypted = await encryptValue("person@example.com", secret);
    expect(encrypted).not.toContain("person@example.com");
    await expect(decryptValue(encrypted, secret)).resolves.toBe("person@example.com");
  });

  it("uses a fresh nonce for each encryption", async () => {
    const first = await encryptValue("person@example.com", secret);
    const second = await encryptValue("person@example.com", secret);
    expect(first).not.toBe(second);
  });

  it("rejects tampered ciphertext", async () => {
    const encrypted = await encryptValue("person@example.com", secret);
    const bytes = Uint8Array.from(atob(encrypted), (character) => character.charCodeAt(0));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(decryptValue(tampered, secret)).rejects.toThrow();
  });

  it("creates stable keyed fingerprints", async () => {
    await expect(keyedFingerprint("email:person@example.com", secret))
      .resolves.toBe(await keyedFingerprint("email:person@example.com", secret));
    await expect(keyedFingerprint("email:other@example.com", secret))
      .resolves.not.toBe(await keyedFingerprint("email:person@example.com", secret));
  });
});
