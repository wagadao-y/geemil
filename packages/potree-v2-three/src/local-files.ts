import { loadPotreeV2 } from './point-cloud.js';
import type { PotreeV2Options, PotreeV2PointCloud } from './point-cloud.js';

const requiredNames = ['metadata.json', 'hierarchy.bin', 'octree.bin'] as const;
type RequiredName = (typeof requiredNames)[number];

/** Find one Potree v2 dataset among selected files. */
export function selectPotreeV2Files(files: FileList | Iterable<File>): Record<RequiredName, File> {
  const directories = new Map<string, Map<string, File>>();
  for (const file of Array.from(files)) {
    const path = file.webkitRelativePath || file.name;
    const slash = path.lastIndexOf('/');
    const directory = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    if (!requiredNames.includes(name as RequiredName)) continue;
    let entries = directories.get(directory);
    if (!entries) {
      entries = new Map();
      directories.set(directory, entries);
    }
    entries.set(name, file);
  }
  const datasets = [...directories.values()].filter((entries) =>
    requiredNames.every((name) => entries.has(name)),
  );
  if (datasets.length === 0) {
    throw new Error(
      'Select metadata.json, hierarchy.bin and octree.bin of one Potree v2 dataset together',
    );
  }
  if (datasets.length > 1) {
    throw new Error(
      'The selected files contain several Potree v2 datasets; select the three files of one dataset',
    );
  }
  const entries = datasets[0]!;
  return {
    'metadata.json': entries.get('metadata.json')!,
    'hierarchy.bin': entries.get('hierarchy.bin')!,
    'octree.bin': entries.get('octree.bin')!,
  };
}

/** Load selected local Potree v2 files without uploading them. */
export async function loadPotreeV2FromFiles(
  files: FileList | Iterable<File>,
  options: PotreeV2Options = {},
): Promise<PotreeV2PointCloud> {
  const selected = selectPotreeV2Files(files);
  const localBase = new URL('https://potree-v2.local/metadata.json');
  const localFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    const name = url.pathname.slice(1) as RequiredName;
    const file = selected[name];
    if (url.origin !== localBase.origin || !file) return new Response(null, { status: 404 });
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    if (name === 'metadata.json') return new Response(file, { status: 200 });

    const headers = new Headers(init?.headers);
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get('Range') ?? '');
    if (!range) throw new Error(`Missing byte range for ${name}`);
    const start = BigInt(range[1]!);
    const end = BigInt(range[2]!);
    if (end < start || end >= BigInt(file.size) || end >= BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${name}: requested byte range is outside the selected file`);
    }
    const part = file.slice(Number(start), Number(end + 1n));
    return new Response(part, {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${file.size}` },
    });
  };
  return loadPotreeV2(localBase, {
    ...options,
    fetch: localFetch,
    cacheEncodedNodes: options.cacheEncodedNodes ?? false,
  });
}
