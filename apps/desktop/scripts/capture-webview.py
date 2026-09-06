"""Capture only the client area of the app directly owned by an E2E Job runner.

Windows-only, standard library. Never captures the desktop or another process.
Run from the native E2E harness; PrintWindow failure is not replaced by a screen grab.
"""
import argparse
import ctypes as c
from ctypes import wintypes as w
import json
from pathlib import Path
import struct
import sys
import zlib


def capture(parent_pid: int, output: Path | None, resize: tuple[int, int] | None = None, resize_only: bool = False) -> dict:
    if sys.platform != "win32":
        raise RuntimeError("Window capture requires Windows.")
    user = c.WinDLL("user32", use_last_error=True)
    kernel = c.WinDLL("kernel32", use_last_error=True)
    gdi = c.WinDLL("gdi32", use_last_error=True)
    pointer = c.c_void_p
    try:
        user.SetProcessDpiAwarenessContext.argtypes = [pointer]
        user.SetProcessDpiAwarenessContext(pointer(-4))
    except AttributeError:
        user.SetProcessDPIAware()

    class ProcessEntry(c.Structure):
        _fields_ = [("dwSize", w.DWORD), ("cntUsage", w.DWORD), ("th32ProcessID", w.DWORD),
                    ("th32DefaultHeapID", c.c_size_t), ("th32ModuleID", w.DWORD),
                    ("cntThreads", w.DWORD), ("th32ParentProcessID", w.DWORD),
                    ("pcPriClassBase", w.LONG), ("dwFlags", w.DWORD), ("szExeFile", w.WCHAR * 260)]

    kernel.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = w.HANDLE
    kernel.Process32FirstW.argtypes = [w.HANDLE, c.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = [w.HANDLE, c.POINTER(ProcessEntry)]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == pointer(-1).value:
        raise RuntimeError("Could not inspect the owned E2E process.")
    children = set()
    process_parents = {}
    try:
        entry = ProcessEntry()
        entry.dwSize = c.sizeof(entry)
        more = kernel.Process32FirstW(snapshot, c.byref(entry))
        while more:
            process_parents[entry.th32ProcessID] = entry.th32ParentProcessID
            if entry.th32ParentProcessID == parent_pid and entry.szExeFile.lower() == "piui-desktop.exe":
                children.add(entry.th32ProcessID)
            more = kernel.Process32NextW(snapshot, c.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    if len(children) != 1:
        raise RuntimeError("Expected one directly owned PiUI E2E process.")

    callback_type = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    user.EnumWindows.argtypes = [callback_type, w.LPARAM]
    user.GetWindowThreadProcessId.argtypes = [w.HWND, c.POINTER(w.DWORD)]
    user.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, c.c_int]
    user.GetWindowTextLengthW.argtypes = [w.HWND]
    user.IsWindowVisible.argtypes = [w.HWND]
    windows = []

    @callback_type
    def visit(hwnd, _):
        pid = w.DWORD()
        user.GetWindowThreadProcessId(hwnd, c.byref(pid))
        if pid.value in children and user.IsWindowVisible(hwnd):
            title = c.create_unicode_buffer(user.GetWindowTextLengthW(hwnd) + 1)
            user.GetWindowTextW(hwnd, title, len(title))
            if title.value == "PiUI E2E":
                windows.append(hwnd)
        return True

    user.EnumWindows(visit, 0)
    if len(windows) != 1:
        raise RuntimeError("Expected one visible owned PiUI E2E window.")
    hwnd = windows[0]
    # Measure only the same verified app and its snapshot descendants. Working
    # sets include shared pages: report their SUM, not unique physical memory.
    owned_pids = set(children)
    while True:
        descendants = {pid for pid, parent in process_parents.items() if parent in owned_pids}
        if descendants <= owned_pids:
            break
        owned_pids.update(descendants)

    class ProcessMemoryCounters(c.Structure):
        _fields_ = [("cb", w.DWORD), ("PageFaultCount", w.DWORD),
                    ("PeakWorkingSetSize", c.c_size_t), ("WorkingSetSize", c.c_size_t),
                    ("QuotaPeakPagedPoolUsage", c.c_size_t), ("QuotaPagedPoolUsage", c.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", c.c_size_t), ("QuotaNonPagedPoolUsage", c.c_size_t),
                    ("PagefileUsage", c.c_size_t), ("PeakPagefileUsage", c.c_size_t),
                    ("PrivateUsage", c.c_size_t)]

    psapi = c.WinDLL("psapi", use_last_error=True)
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.OpenProcess.restype = w.HANDLE
    psapi.GetProcessMemoryInfo.argtypes = [w.HANDLE, c.POINTER(ProcessMemoryCounters), w.DWORD]
    psapi.GetProcessMemoryInfo.restype = w.BOOL
    measured, working_set, private_bytes = 0, 0, 0
    for pid in owned_pids:
        process = kernel.OpenProcess(0x1000 | 0x10, False, pid)
        if not process:
            continue
        try:
            counters = ProcessMemoryCounters()
            counters.cb = c.sizeof(counters)
            if psapi.GetProcessMemoryInfo(process, c.byref(counters), counters.cb):
                measured += 1
                working_set += counters.WorkingSetSize
                private_bytes += counters.PrivateUsage
        finally:
            kernel.CloseHandle(process)
    memory = {"scope": "snapshot-of-owned-app-process-tree", "processesFound": len(owned_pids),
              "processesMeasured": measured, "complete": measured == len(owned_pids),
              "sumWorkingSetBytes": working_set, "sumPrivateBytes": private_bytes}
    if resize is not None:
        logical_width, logical_height = resize
        if logical_width <= 0 or logical_height <= 0:
            raise RuntimeError("Window dimensions must be positive.")
        user.GetDpiForWindow.argtypes = [w.HWND]
        user.GetDpiForWindow.restype = w.UINT
        dpi = user.GetDpiForWindow(hwnd)
        if not dpi:
            raise RuntimeError("Could not read the owned window DPI.")
        bounds = w.RECT(0, 0, round(logical_width * dpi / 96), round(logical_height * dpi / 96))
        user.GetWindowLongW.argtypes = [w.HWND, c.c_int]
        user.GetWindowLongW.restype = w.LONG
        user.AdjustWindowRectExForDpi.argtypes = [c.POINTER(w.RECT), w.DWORD, w.BOOL, w.DWORD, w.UINT]
        if not user.AdjustWindowRectExForDpi(c.byref(bounds), user.GetWindowLongW(hwnd, -16) & 0xffffffff,
                                           False, user.GetWindowLongW(hwnd, -20) & 0xffffffff, dpi):
            raise RuntimeError("Could not calculate the owned window frame.")
        user.SetWindowPos.argtypes = [w.HWND, w.HWND, c.c_int, c.c_int, c.c_int, c.c_int, w.UINT]
        # SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE: do not move/activate unrelated windows.
        if not user.SetWindowPos(hwnd, None, 0, 0, bounds.right - bounds.left, bounds.bottom - bounds.top, 22):
            raise RuntimeError("Could not resize the owned E2E window.")
        if resize_only:
            return {"status": "resized", "width": logical_width, "height": logical_height}
    if output is None:
        raise RuntimeError("Screenshot output is required.")
    user.GetClientRect.argtypes = [w.HWND, c.POINTER(w.RECT)]
    rect = w.RECT()
    if not user.GetClientRect(hwnd, c.byref(rect)):
        raise RuntimeError("Could not read the E2E client area.")
    width, height = rect.right - rect.left, rect.bottom - rect.top
    if width <= 0 or height <= 0:
        raise RuntimeError("The E2E client area is empty.")

    class BitmapInfoHeader(c.Structure):
        _fields_ = [("biSize", w.DWORD), ("biWidth", w.LONG), ("biHeight", w.LONG),
                    ("biPlanes", w.WORD), ("biBitCount", w.WORD), ("biCompression", w.DWORD),
                    ("biSizeImage", w.DWORD), ("biXPelsPerMeter", w.LONG), ("biYPelsPerMeter", w.LONG),
                    ("biClrUsed", w.DWORD), ("biClrImportant", w.DWORD)]

    user.GetDC.argtypes = [w.HWND]
    user.GetDC.restype = w.HDC
    user.ReleaseDC.argtypes = [w.HWND, w.HDC]
    user.PrintWindow.argtypes = [w.HWND, w.HDC, w.UINT]
    gdi.CreateCompatibleDC.argtypes = [w.HDC]
    gdi.CreateCompatibleDC.restype = w.HDC
    gdi.CreateDIBSection.argtypes = [w.HDC, c.POINTER(BitmapInfoHeader), w.UINT, c.POINTER(pointer), w.HANDLE, w.DWORD]
    gdi.CreateDIBSection.restype = w.HBITMAP
    gdi.SelectObject.argtypes = [w.HDC, w.HGDIOBJ]
    gdi.SelectObject.restype = w.HGDIOBJ
    gdi.DeleteObject.argtypes = [w.HGDIOBJ]
    gdi.DeleteDC.argtypes = [w.HDC]
    dc = user.GetDC(hwnd)
    memory_dc = gdi.CreateCompatibleDC(dc)
    bits = pointer()
    header = BitmapInfoHeader(c.sizeof(BitmapInfoHeader), width, -height, 1, 32, 0, width * height * 4, 0, 0, 0, 0)
    bitmap = gdi.CreateDIBSection(dc, c.byref(header), 0, c.byref(bits), None, 0)
    previous = None
    try:
        if not dc or not memory_dc or not bitmap or not bits:
            raise RuntimeError("Could not allocate the owned window capture.")
        previous = gdi.SelectObject(memory_dc, bitmap)
        # PW_CLIENTONLY | PW_RENDERFULLCONTENT. No desktop pixels are copied.
        if not user.PrintWindow(hwnd, memory_dc, 3):
            raise RuntimeError("The owned WebView did not provide window pixels.")
        raw = c.string_at(bits, width * height * 4)
        rgb = bytearray(width * height * 3)
        rgb[0::3], rgb[1::3], rgb[2::3] = raw[2::4], raw[1::4], raw[0::4]
        scanlines = b"".join(b"\0" + rgb[row * width * 3:(row + 1) * width * 3] for row in range(height))
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        png += chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b"")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(png)
        return {"status": "captured", "width": width, "height": height, "path": str(output), "memory": memory}
    finally:
        if previous:
            gdi.SelectObject(memory_dc, previous)
        if bitmap:
            gdi.DeleteObject(bitmap)
        if memory_dc:
            gdi.DeleteDC(memory_dc)
        if dc:
            user.ReleaseDC(hwnd, dc)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent-pid", type=int, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--resize", nargs=2, type=int, metavar=("WIDTH", "HEIGHT"))
    parser.add_argument("--resize-only", action="store_true")
    args = parser.parse_args()
    if args.resize_only and args.resize is None:
        parser.error("--resize-only requires --resize")
    try:
        print(json.dumps(capture(args.parent_pid, args.output, tuple(args.resize) if args.resize else None, args.resize_only)))
    except (OSError, RuntimeError) as error:
        print(json.dumps({"status": "failed", "reason": str(error)}))
        raise SystemExit(1)
