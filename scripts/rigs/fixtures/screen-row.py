"""Prints a row of the X screen each time it changes, for a time: `screen-row.py x y width milliseconds`. Each line is
the milliseconds since the first and the row's pixels in hex. The first line is printed once sampling starts."""
import ctypes
import json
import sys
import time

x, y, width, duration = (int(value) for value in sys.argv[1:5])


class Image(ctypes.Structure):
    _fields_ = [("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int), ("format", ctypes.c_int),
                ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int), ("bitmap_unit", ctypes.c_int),
                ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int),
                ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int)]


x11 = ctypes.CDLL("libX11.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                          ctypes.c_ulong, ctypes.c_int]
x11.XGetImage.restype = ctypes.POINTER(Image)
x11.XFree.argtypes = [ctypes.c_void_p]
display = x11.XOpenDisplay(None)
root = x11.XDefaultRootWindow(display)
start = time.monotonic()
last = None
while (elapsed := time.monotonic() - start) < duration / 1000:
    image = x11.XGetImage(display, root, x, y, width, 1, 0xFFFFFFFF, 2)
    row = ctypes.string_at(image.contents.data, image.contents.bytes_per_line).hex()
    x11.XFree(image.contents.data)
    x11.XFree(image)
    if row != last:
        print(json.dumps([round(elapsed * 1000, 1), row]), flush=True)
        last = row
