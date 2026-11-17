export const STACK_PORT_BASES: readonly number[] = [5432, 10020, 9229, 3000, 3010, 3001];
export const CANDIDATE_OFFSETS: readonly number[] = [5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700, 5800, 5900];

export type IsPortAvailable = (port: number) => Promise<boolean>;

export function portsForOffset(offset: number): readonly number[] {
  return STACK_PORT_BASES.map((base) => base + offset);
}

async function allPortsAvailable(ports: readonly number[], isPortAvailable: IsPortAvailable): Promise<boolean> {
  for (const port of ports) {
    if (!(await isPortAvailable(port))) return false;
  }
  return true;
}

export async function findFreePortOffset(input: {
  candidateOffsets: readonly number[];
  isPortAvailable: IsPortAvailable;
}): Promise<number> {
  for (const offset of input.candidateOffsets) {
    if (await allPortsAvailable(portsForOffset(offset), input.isPortAvailable)) return offset;
  }
  throw new Error(`no free port offset among ${input.candidateOffsets.join(", ")}`);
}
