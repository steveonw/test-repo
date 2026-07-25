#!/usr/bin/env python3
"""Combine x86_64 and arm64 thin Mach-O executables into one universal binary.

This implements the small part of Apple's fat Mach-O container format needed
for the two Go binaries produced by this project. It avoids requiring `lipo`
on a Linux build host. The output should still be codesigned on macOS before
public distribution.
"""

from __future__ import annotations

import argparse
import os
import struct
from dataclasses import dataclass
from pathlib import Path

FAT_MAGIC = 0xCAFEBABE
MH_MAGIC_64 = 0xFEEDFACF
ALIGN_POWER = 14  # 16 KiB, conventional for 64-bit Mach-O slices


@dataclass(frozen=True)
class Slice:
    data: bytes
    cpu_type: int
    cpu_subtype: int


def read_slice(path: Path) -> Slice:
    data = path.read_bytes()
    if len(data) < 12:
        raise ValueError(f"{path} is too small to be a Mach-O executable")

    magic_le, cpu_type, cpu_subtype = struct.unpack_from("<Iii", data, 0)
    if magic_le != MH_MAGIC_64:
        raise ValueError(f"{path} is not a little-endian 64-bit Mach-O executable")

    return Slice(data=data, cpu_type=cpu_type, cpu_subtype=cpu_subtype)


def align(value: int, power: int) -> int:
    boundary = 1 << power
    return (value + boundary - 1) & ~(boundary - 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--x86_64", required=True, type=Path)
    parser.add_argument("--arm64", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    slices = [read_slice(args.x86_64), read_slice(args.arm64)]
    header_size = 8 + len(slices) * 20
    offsets: list[int] = []
    cursor = header_size
    for item in slices:
        cursor = align(cursor, ALIGN_POWER)
        offsets.append(cursor)
        cursor += len(item.data)

    output = bytearray(cursor)
    struct.pack_into(">II", output, 0, FAT_MAGIC, len(slices))

    table_offset = 8
    for item, data_offset in zip(slices, offsets):
        struct.pack_into(
            ">iiIII",
            output,
            table_offset,
            item.cpu_type,
            item.cpu_subtype,
            data_offset,
            len(item.data),
            ALIGN_POWER,
        )
        table_offset += 20
        output[data_offset : data_offset + len(item.data)] = item.data

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(output)
    os.chmod(args.output, 0o755)


if __name__ == "__main__":
    main()
