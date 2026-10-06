// A one-line hardware summary of this machine (CPU, memory, GPUs, free disk),
// gathered once with read-only commands and put in the prompt, so a small
// model does not have to go looking for it.

async function out(cmd: string, args: string[], ms = 15_000): Promise<string> {
  try {
    const o = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(ms),
    }).output();
    return o.code === 0 ? new TextDecoder().decode(o.stdout).trim() : "";
  } catch {
    return "";
  }
}

const gb = (bytes: number) => `${Math.round(bytes / 2 ** 30)} GB`;

/** Free space in the home directory, from df. */
async function freeDisk(): Promise<string> {
  if (Deno.build.os === "windows") {
    const free = await out("powershell", [
      "-NoProfile",
      "-Command",
      "(Get-PSDrive -Name ($env:SystemDrive.Trim(':'))).Free",
    ]);
    return free ? `${gb(Number(free))} free disk` : "";
  }
  const df = await out("df", ["-k", Deno.env.get("HOME") ?? "/"]);
  const kb = Number(df.split("\n").at(-1)?.trim().split(/\s+/)[3]);
  return kb ? `${gb(kb * 1024)} free disk in the home directory` : "";
}

export function summarizeMac(
  cpu: string,
  memBytes: number,
  cores: string,
  displays: string,
  wiredLimitMb: number,
): string {
  const parts: string[] = [];
  if (cpu) parts.push(`${cpu}${cores ? `, ${cores} CPU cores` : ""}`);
  const gpus = [...displays.matchAll(/Chipset Model:\s*(.+)/g)].map((m) => m[1].trim());
  const gpuCores = displays.match(/Total Number of Cores:\s*(\d+)/)?.[1];
  const vram = displays.match(/VRAM[^:]*:\s*(.+)/)?.[1]?.trim();
  const apple = /Apple/.test(cpu) || gpus.some((g) => /Apple/.test(g));
  if (memBytes) {
    if (apple) {
      const usable = wiredLimitMb > 0 ? wiredLimitMb * 2 ** 20 : memBytes * 0.75;
      parts.push(
        `${gb(memBytes)} unified memory (the GPU can use about ${gb(usable)}${
          wiredLimitMb > 0 ? `, iogpu.wired_limit_mb=${wiredLimitMb}` : " by default"
        })`,
      );
    } else parts.push(`${gb(memBytes)} RAM`);
  }
  if (gpus.length) {
    parts.push(
      `GPU: ${gpus.join(", ")}${gpuCores ? ` (${gpuCores} cores, Metal)` : ""}${
        vram ? `, ${vram} VRAM` : ""
      }`,
    );
  }
  return parts.join("; ");
}

export function summarizeLinux(
  lscpu: string,
  meminfo: string,
  nvidia: string,
  lspci: string,
): string {
  const parts: string[] = [];
  const model = lscpu.match(/^Model name:\s*(.+)$/m)?.[1]?.trim();
  const cpus = lscpu.match(/^CPU\(s\):\s*(\d+)/m)?.[1];
  if (model) parts.push(`${model}${cpus ? `, ${cpus} CPU threads` : ""}`);
  const kb = Number(meminfo.match(/^MemTotal:\s*(\d+)/m)?.[1]);
  if (kb) parts.push(`${gb(kb * 1024)} RAM`);
  const nv = nvidia.split("\n").map((l) => l.trim()).filter(Boolean);
  if (nv.length) {
    parts.push(
      `NVIDIA GPU${nv.length > 1 ? `s (${nv.length})` : ""}: ${
        nv.map((l) => l.replace(/,\s*/, " with ")).join("; ")
      }`,
    );
  } else {
    const vga = lspci.split("\n").filter((l) => /VGA|3D|Display/i.test(l))
      .map((l) => l.replace(/^\S+\s+[^:]+:\s*/, "").trim()).filter(Boolean);
    parts.push(vga.length ? `GPU: ${vga.join("; ")} (no nvidia-smi)` : "no GPU found");
  }
  return parts.join("; ");
}

let cached: string | null = null;

export async function hardwareSummary(): Promise<string> {
  if (cached !== null) return cached;
  let s = "";
  if (Deno.build.os === "darwin") {
    const [cpu, mem, cores, displays, wired] = await Promise.all([
      out("sysctl", ["-n", "machdep.cpu.brand_string"]),
      out("sysctl", ["-n", "hw.memsize"]),
      out("sysctl", ["-n", "hw.ncpu"]),
      out("system_profiler", ["SPDisplaysDataType"]),
      out("sysctl", ["-n", "iogpu.wired_limit_mb"]),
    ]);
    s = summarizeMac(cpu, Number(mem) || 0, cores, displays, Number(wired) || 0);
  } else if (Deno.build.os === "linux") {
    const [lscpu, meminfo, nvidia, lspci] = await Promise.all([
      out("lscpu", []),
      Deno.readTextFile("/proc/meminfo").catch(() => ""),
      out("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]),
      out("lspci", []),
    ]);
    s = summarizeLinux(lscpu, meminfo, nvidia, lspci);
  } else if (Deno.build.os === "windows") {
    const ps = await out("powershell", [
      "-NoProfile",
      "-Command",
      "$c=(Get-CimInstance Win32_Processor | Select -First 1).Name; $m=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; $g=(Get-CimInstance Win32_VideoController | % { $_.Name }) -join ', '; \"$c|$m|$g\"",
    ]);
    const [cpu, mem, gpus] = ps.split("|");
    s = [cpu, mem ? `${gb(Number(mem))} RAM` : "", gpus ? `GPU: ${gpus}` : ""].filter(Boolean)
      .join("; ");
  }
  const disk = await freeDisk();
  cached = [s, disk].filter(Boolean).join("; ") || "unknown";
  return cached;
}
