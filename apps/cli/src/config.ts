import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Profile {
  url: string;
  token: string;
  kind: 'api_key' | 'session';
  /** Who the token belongs to, for `morrow whoami` without a network call. */
  label?: string;
  workspaceId?: string | null;
}

export interface CliConfig {
  current: string;
  profiles: Record<string, Profile>;
}

/** ~/.config/morrow/config.json (or %APPDATA%\morrow\config.json), overridable with MORROW_CONFIG. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MORROW_CONFIG) return env.MORROW_CONFIG;
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'morrow', 'config.json');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'morrow', 'config.json');
}

export function readConfig(path = configPath()): CliConfig {
  if (!existsSync(path)) return { current: 'default', profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CliConfig>;
    return { current: parsed.current ?? 'default', profiles: parsed.profiles ?? {} };
  } catch {
    return { current: 'default', profiles: {} };
  }
}

/** Credentials are written owner-readable only. */
export function writeConfig(config: CliConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not supported on every filesystem (e.g. Windows); the ACL of the profile folder applies.
  }
}

export function saveProfile(name: string, profile: Profile, path = configPath()): void {
  const config = readConfig(path);
  config.profiles[name] = profile;
  config.current = name;
  writeConfig(config, path);
}

export function removeProfile(name: string, path = configPath()): boolean {
  const config = readConfig(path);
  if (!config.profiles[name]) return false;
  delete config.profiles[name];
  if (config.current === name) config.current = Object.keys(config.profiles)[0] ?? 'default';
  writeConfig(config, path);
  return true;
}
