
import time
import numpy as np
import openvino as ov


MODEL_PATH = "yolov8n.onnx"

WARMUP_COUNT = 20
TEST_COUNT = 100


def benchmark_device(core, model, device):
    print(f"\n[{device}] 모델 컴파일 중...")

    try:
        compiled_model = core.compile_model(model, device)
        request = compiled_model.create_infer_request()

        input_port = compiled_model.input(0)
        input_shape = list(input_port.shape)

        input_data = np.random.rand(*input_shape).astype(np.float32)

        print(f"[{device}] 입력 크기: {input_shape}")
        print(f"[{device}] 워밍업 시작...")

        for _ in range(WARMUP_COUNT):
            request.infer({input_port: input_data})

        print(f"[{device}] 실제 측정 시작...")

        times = []

        for _ in range(TEST_COUNT):
            start = time.perf_counter()

            request.infer({input_port: input_data})

            elapsed = (time.perf_counter() - start) * 1000
            times.append(elapsed)

        avg_ms = sum(times) / len(times)
        min_ms = min(times)
        max_ms = max(times)
        fps = 1000 / avg_ms

        print(f"\n[{device}] 측정 결과")
        print(f"평균 추론 시간: {avg_ms:.2f} ms")
        print(f"최소 추론 시간: {min_ms:.2f} ms")
        print(f"최대 추론 시간: {max_ms:.2f} ms")
        print(f"추론 FPS: {fps:.2f}")

        return avg_ms

    except Exception as e:
        print(f"\n[{device}] 테스트 실패")
        print(e)
        return None


def main():
    core = ov.Core()

    print("=" * 50)
    print("OpenVINO YOLOv8n CPU / GPU 벤치마크")
    print("=" * 50)

    print("OpenVINO 버전:", ov.__version__)
    print("사용 가능한 장치:", core.available_devices)

    model = core.read_model(MODEL_PATH)

    results = {}

    for device in ["CPU", "GPU"]:
        if device not in core.available_devices:
            print(f"\n{device} 장치를 찾을 수 없어 건너뜁니다.")
            continue

        results[device] = benchmark_device(core, model, device)

    print("\n" + "=" * 50)
    print("최종 비교")
    print("=" * 50)

    for device, avg_ms in results.items():
        if avg_ms is not None:
            print(
                f"{device}: {avg_ms:.2f} ms "
                f"({1000 / avg_ms:.2f} FPS)"
            )

    if (
        results.get("CPU") is not None
        and results.get("GPU") is not None
    ):
        cpu = results["CPU"]
        gpu = results["GPU"]

        if gpu < cpu:
            print(f"\nGPU가 CPU보다 약 {cpu / gpu:.2f}배 빠릅니다.")
        else:
            print(f"\nCPU가 GPU보다 약 {gpu / cpu:.2f}배 빠릅니다.")


if __name__ == "__main__":
    main()
