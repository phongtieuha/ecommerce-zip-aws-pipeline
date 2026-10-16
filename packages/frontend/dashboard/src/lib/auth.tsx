import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface AuthTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

interface AuthContextValue {
  readonly isAuthenticated: boolean;
  readonly isLoading: boolean;
  readonly userEmail: string | null;
  readonly login: (options?: { readonly loginHint?: string }) => Promise<void>;
  readonly logout: () => void;
  readonly getAccessToken: () => Promise<string | null>;
}

interface TokenResponse {
  readonly access_token: string;
  readonly id_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
}

const TOKENS_STORAGE_KEY = "filepipeline.dashboard.auth.tokens";
const PKCE_VERIFIER_KEY = "filepipeline.dashboard.auth.pkceVerifier";
const OAUTH_STATE_KEY = "filepipeline.dashboard.auth.oauthState";
const EXPIRY_SKEW_MS = 30_000;

let pendingOAuthCallbackPromise: Promise<AuthTokens | null> | null = null;

const AuthContext = createContext<AuthContextValue | null>(null);

function getEnv(name: string): string {
  const value = import.meta.env[name] as string | undefined;
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is not configured.`);
  }
  return value;
}

function getOptionalEnv(name: string): string | null {
  const value = import.meta.env[name] as string | undefined;
  return value && value.trim().length > 0 ? value : null;
}

function awsRegion(): string {
  return getOptionalEnv("VITE_AWS_REGION") ?? "ap-southeast-1";
}

function normalizeCognitoDomain(input: string): string {
  const trimmed = input.trim();
  const withoutScheme = trimmed.replace(/^https?:\/\//, "");

  const hostedDomain = withoutScheme.includes(".")
    ? withoutScheme
    : `${withoutScheme}.auth.${awsRegion()}.amazoncognito.com`;

  return `https://${hostedDomain}`;
}

function redirectUri(): string {
  return getOptionalEnv("VITE_COGNITO_REDIRECT_URI") ?? window.location.origin;
}

function logoutRedirectUri(): string {
  return getOptionalEnv("VITE_COGNITO_LOGOUT_REDIRECT_URI") ?? window.location.origin;
}

function oauthScope(): string {
  return getOptionalEnv("VITE_COGNITO_SCOPE") ?? "openid email profile";
}

function saveTokens(tokens: AuthTokens) {
  localStorage.setItem(TOKENS_STORAGE_KEY, JSON.stringify(tokens));
}

function loadTokens(): AuthTokens | null {
  const raw = localStorage.getItem(TOKENS_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AuthTokens>;
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.idToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }

    return {
      accessToken: parsed.accessToken,
      idToken: parsed.idToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function clearStoredAuth() {
  localStorage.removeItem(TOKENS_STORAGE_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);
}

function isTokenValid(tokens: AuthTokens): boolean {
  return Date.now() + EXPIRY_SKEW_MS < tokens.expiresAt;
}

function randomString(length = 64): string {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => charset[byte % charset.length]!).join("");
}

function toBase64Url(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(digest);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;

  try {
    const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload = atob(padded);
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildTokens(response: TokenResponse, existingRefreshToken?: string): AuthTokens {
  const refreshToken = response.refresh_token ?? existingRefreshToken;
  if (!refreshToken) {
    throw new Error("Missing refresh token from Cognito token response.");
  }

  return {
    accessToken: response.access_token,
    idToken: response.id_token,
    refreshToken,
    expiresAt: Date.now() + response.expires_in * 1000,
  };
}

async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<AuthTokens> {
  const domain = normalizeCognitoDomain(getEnv("VITE_COGNITO_DOMAIN"));
  const clientId = getEnv("VITE_COGNITO_CLIENT_ID");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri(),
    code_verifier: codeVerifier,
  });

  const response = await fetch(`${domain}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Failed to exchange auth code: ${response.status}`);
  }

  const tokenResponse = (await response.json()) as TokenResponse;
  return buildTokens(tokenResponse);
}

async function refreshTokens(tokens: AuthTokens): Promise<AuthTokens> {
  const domain = normalizeCognitoDomain(getEnv("VITE_COGNITO_DOMAIN"));
  const clientId = getEnv("VITE_COGNITO_CLIENT_ID");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refreshToken,
  });

  const response = await fetch(`${domain}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh token: ${response.status}`);
  }

  const tokenResponse = (await response.json()) as TokenResponse;
  return buildTokens(tokenResponse, tokens.refreshToken);
}

async function loginWithHostedUi(options?: { readonly loginHint?: string }) {
  const domain = normalizeCognitoDomain(getEnv("VITE_COGNITO_DOMAIN"));
  const clientId = getEnv("VITE_COGNITO_CLIENT_ID");
  const state = randomString(32);
  const codeVerifier = randomString(96);
  const codeChallenge = await createCodeChallenge(codeVerifier);

  sessionStorage.setItem(OAUTH_STATE_KEY, state);
  sessionStorage.setItem(PKCE_VERIFIER_KEY, codeVerifier);

  const authorizeUrl = new URL(`${domain}/oauth2/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", oauthScope());
  authorizeUrl.searchParams.set("redirect_uri", redirectUri());
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  if (options?.loginHint) {
    authorizeUrl.searchParams.set("login_hint", options.loginHint);
  }

  window.location.assign(authorizeUrl.toString());
}

async function completeOAuthCallback(): Promise<AuthTokens | null> {
  if (pendingOAuthCallbackPromise) {
    return pendingOAuthCallbackPromise;
  }

  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) return null;

  const storedState = sessionStorage.getItem(OAUTH_STATE_KEY);
  const codeVerifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);

  if (!state || !storedState || state !== storedState || !codeVerifier) {
    clearStoredAuth();
    throw new Error("Invalid OAuth callback state.");
  }

  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  window.history.replaceState({}, "", url.toString());

  pendingOAuthCallbackPromise = (async () => {
    const tokens = await exchangeCodeForTokens(code, codeVerifier);

    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);

    return tokens;
  })();

  try {
    return await pendingOAuthCallbackPromise;
  } finally {
    pendingOAuthCallbackPromise = null;
  }
}

function parseUserEmail(idToken: string): string | null {
  const payload = decodeJwtPayload(idToken);
  const email = payload?.["email"];
  return typeof email === "string" ? email : null;
}

function buildHostedUiLogoutUrl(): string | null {
  const domain = getOptionalEnv("VITE_COGNITO_DOMAIN");
  const clientId = getOptionalEnv("VITE_COGNITO_CLIENT_ID");
  if (!domain || !clientId) return null;

  const logoutUrl = new URL(`${normalizeCognitoDomain(domain)}/logout`);
  logoutUrl.searchParams.set("client_id", clientId);
  logoutUrl.searchParams.set("logout_uri", logoutRedirectUri());
  return logoutUrl.toString();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokens] = useState<AuthTokens | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const callbackTokens = await completeOAuthCallback();
        if (callbackTokens) {
          saveTokens(callbackTokens);
          if (!cancelled) {
            setTokens(callbackTokens);
            setUserEmail(parseUserEmail(callbackTokens.idToken));
          }
          return;
        }

        const stored = loadTokens();
        if (!stored) return;

        if (isTokenValid(stored)) {
          if (!cancelled) {
            setTokens(stored);
            setUserEmail(parseUserEmail(stored.idToken));
          }
          return;
        }

        const refreshed = await refreshTokens(stored);
        if (!cancelled) {
          saveTokens(refreshed);
          setTokens(refreshed);
          setUserEmail(parseUserEmail(refreshed.idToken));
        }
      } catch {
        if (!cancelled) {
          clearStoredAuth();
          setTokens(null);
          setUserEmail(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void init();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (options?: { readonly loginHint?: string }) => {
    await loginWithHostedUi(options);
  }, []);

  const logout = useCallback(() => {
    clearStoredAuth();
    setTokens(null);
    setUserEmail(null);

    const hostedUiLogoutUrl = buildHostedUiLogoutUrl();
    if (!hostedUiLogoutUrl) {
      window.location.reload();
      return;
    }

    window.location.assign(hostedUiLogoutUrl);
  }, []);

  const getAccessToken = useCallback(async () => {
    if (!tokens) return null;

    if (isTokenValid(tokens)) {
      return tokens.accessToken;
    }

    try {
      const refreshed = await refreshTokens(tokens);
      saveTokens(refreshed);
      setTokens(refreshed);
      setUserEmail(parseUserEmail(refreshed.idToken));
      return refreshed.accessToken;
    } catch {
      clearStoredAuth();
      setTokens(null);
      setUserEmail(null);
      return null;
    }
  }, [tokens]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: Boolean(tokens),
      isLoading,
      userEmail,
      login,
      logout,
      getAccessToken,
    }),
    [getAccessToken, isLoading, login, logout, tokens, userEmail],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
