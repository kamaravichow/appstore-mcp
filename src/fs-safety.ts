import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { SafetyError } from "./errors.js";

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

export async function resolveInputFile(
  root: string,
  requestedPath: string,
): Promise<string> {
  const realRoot = await realpath(root).catch(() => {
    throw new SafetyError(`Upload root does not exist: ${root}`);
  });
  const candidate = resolve(realRoot, requestedPath);
  const realCandidate = await realpath(candidate).catch(() => {
    throw new SafetyError(`Upload file does not exist: ${requestedPath}`);
  });
  if (!isWithin(realRoot, realCandidate)) {
    throw new SafetyError(
      `Upload file must be inside ASC_UPLOAD_ROOT (${realRoot})`,
    );
  }
  return realCandidate;
}

export async function resolveOutputFile(
  root: string,
  requestedPath: string,
): Promise<string> {
  if (!requestedPath.trim()) {
    throw new SafetyError("A non-empty output path is required");
  }
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const candidate = resolve(realRoot, requestedPath);
  if (!isWithin(realRoot, candidate)) {
    throw new SafetyError(
      `Download path must be inside ASC_DOWNLOAD_ROOT (${realRoot})`,
    );
  }

  await mkdir(dirname(candidate), { recursive: true });
  const realParent = await realpath(dirname(candidate));
  if (!isWithin(realRoot, realParent)) {
    throw new SafetyError(
      `Download path resolves outside ASC_DOWNLOAD_ROOT (${realRoot})`,
    );
  }
  return candidate;
}
