import openvino as ov

core = ov.Core()

print("OpenVINO 버전:", ov.__version__)
print("장치 목록:", core.available_devices)

for device in core.available_devices:
    print(device, core.get_property(device, "FULL_DEVICE_NAME"))