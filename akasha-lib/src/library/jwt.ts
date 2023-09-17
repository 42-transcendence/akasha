import * as jose from "jose";

export type JWTHashAlgorithm = "HS256" | "HS384" | "HS512";

export type JWTOptions = {
  issuer?: string | undefined;
  subject?: string | undefined;
  audience?: string | undefined;
};

type JWTSuccessful = { success: true; payload: Record<string, unknown> };

type JWTFailed = { success: false; expired: boolean };

type JWTResult = JWTSuccessful | JWTFailed;

export async function jwtSignatureHMAC(
  algorithm: JWTHashAlgorithm,
  secret: Uint8Array,
  payload: Record<string, unknown>,
  expireSecs?: number | undefined,
  option?: JWTOptions | undefined
): Promise<string> {
  const now: number = Math.floor(Date.now() / 1000);

  const signature = new jose.SignJWT(payload);
  signature.setProtectedHeader({ alg: algorithm, typ: "JWT" });
  if (option?.issuer !== undefined) {
    signature.setIssuer(option.issuer);
  }
  if (option?.subject !== undefined) {
    signature.setSubject(option.subject);
  }
  if (option?.audience !== undefined) {
    signature.setAudience(option.audience);
  }
  if (expireSecs !== undefined) {
    const expiredAt: number = now + Math.floor(expireSecs);
    signature.setExpirationTime(expiredAt);
  }
  signature.setIssuedAt(now);

  const jwt = await signature.sign(secret);
  return jwt;
}

export async function jwtVerifyHMAC(
  jwt: string,
  algorithm: JWTHashAlgorithm,
  secret: Uint8Array,
  option?: JWTOptions | undefined
): Promise<JWTResult> {
  try {
    const { payload } = await jose.jwtVerify(jwt, secret, {
      algorithms: [algorithm],
      typ: "JWT",
      ...option,
    });
    return { success: true, payload };
  } catch (e) {
    return { success: false, expired: e instanceof jose.errors.JWTExpired };
  }
}
