/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Whether the runtime is actually Podman behind the docker wrapper. */
const IS_PODMAN = (() => {
  try {
    return execSync('docker --version 2>/dev/null', { encoding: 'utf-8' }).includes('podman');
  } catch {
    return false;
  }
})();

/** Whether SELinux is enforcing (requires :Z label on bind mounts). */
const SELINUX_ENFORCING = (() => {
  try {
    return fs.readFileSync('/sys/fs/selinux/enforce', 'utf-8').trim() === '1';
  } catch {
    return false;
  }
})();

/** Volume mount suffix for SELinux relabeling. */
const MOUNT_SUFFIX = SELINUX_ENFORCING ? ':Z' : '';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  const args: string[] = [];
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    args.push('--add-host=host.docker.internal:host-gateway');
  }
  return args;
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  // Cannot relabel device files like /dev/null
  const useZ = SELINUX_ENFORCING && !hostPath.startsWith('/dev/');
  const opts = useZ ? 'ro,Z' : 'ro';
  return ['-v', `${hostPath}:${containerPath}:${opts}`];
}

/** Returns the volume suffix string for writable bind mounts. */
export function writableMountSuffix(): string {
  return MOUNT_SUFFIX;
}

/**
 * Post-process container args to add SELinux :Z labels to volume mounts
 * injected by external SDKs (e.g. OneCLI) that don't know about SELinux.
 * Skips /dev/* paths which cannot be relabeled.
 */
export function fixupSELinuxMounts(args: string[]): void {
  if (!SELINUX_ENFORCING) return;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-v' && i + 1 < args.length) {
      const mount = args[i + 1];
      const hostPath = mount.split(':')[0];
      if (hostPath.startsWith('/dev/')) continue;
      if (!mount.includes(':Z') && !mount.includes(',Z')) {
        // Add Z to existing options or append :Z
        const parts = mount.split(':');
        if (parts.length === 3) {
          parts[2] = parts[2] + ',Z';
        } else if (parts.length === 2) {
          parts.push('Z');
        }
        args[i + 1] = parts.join(':');
      }
    }
  }
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
