// libjxl 0.12.0 as a C-in-wasm reference for codecs/bench (web/cwasm.mjs), with the same
// interface as the Cornerstone codec packages: getEncodedBuffer(n), decode(), getDecodedBuffer(),
// getFrameInfo(). Single-threaded; integer output at the codestream's bit depth (8 bits or
// 16 bits little-endian), colour channels only, interleaved: what the DICOM wrapper returns.
#include <emscripten/bind.h>
#include <jxl/decode.h>

#include <stdexcept>
#include <vector>

using namespace emscripten;

struct FrameInfo {
  uint32_t width = 0, height = 0, bitsPerSample = 0, componentCount = 0;
  bool isSigned = false;
};

class JxlDecoderWasm {
 public:
  val getEncodedBuffer(size_t n) {
    encoded_.resize(n);
    return val(typed_memory_view(encoded_.size(), encoded_.data()));
  }
  val getDecodedBuffer() { return val(typed_memory_view(decoded_.size(), decoded_.data())); }
  FrameInfo getFrameInfo() const { return info_; }

  void decode() {
    JxlDecoder* dec = JxlDecoderCreate(nullptr);
    JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE);
    JxlDecoderSetInput(dec, encoded_.data(), encoded_.size());
    JxlDecoderCloseInput(dec);
    JxlPixelFormat pf = {3, JXL_TYPE_UINT8, JXL_LITTLE_ENDIAN, 0};
    bool done = false;
    while (!done) {
      JxlDecoderStatus s = JxlDecoderProcessInput(dec);
      if (s == JXL_DEC_BASIC_INFO) {
        JxlBasicInfo bi;
        JxlDecoderGetBasicInfo(dec, &bi);
        pf.num_channels = bi.num_color_channels;
        pf.data_type = bi.bits_per_sample > 8 ? JXL_TYPE_UINT16 : JXL_TYPE_UINT8;
        info_ = {bi.xsize, bi.ysize, bi.bits_per_sample, bi.num_color_channels, false};
      } else if (s == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
        size_t size = 0;
        JxlDecoderImageOutBufferSize(dec, &pf, &size);
        decoded_.resize(size);
        JxlDecoderSetImageOutBuffer(dec, &pf, decoded_.data(), decoded_.size());
        // Values at the codestream's bit depth (12-bit stays 0..4095), not scaled to 16 bits.
        JxlBitDepth depth = {JXL_BIT_DEPTH_FROM_CODESTREAM, 0, 0};
        JxlDecoderSetImageOutBitDepth(dec, &depth);
      } else if (s == JXL_DEC_FULL_IMAGE || s == JXL_DEC_SUCCESS) {
        done = true;
      } else {
        JxlDecoderDestroy(dec);
        throw std::runtime_error("libjxl decode failed");
      }
    }
    JxlDecoderDestroy(dec);
  }

 private:
  std::vector<uint8_t> encoded_, decoded_;
  FrameInfo info_;
};

EMSCRIPTEN_BINDINGS(libjxl_bench) {
  value_object<FrameInfo>("FrameInfo")
      .field("width", &FrameInfo::width)
      .field("height", &FrameInfo::height)
      .field("bitsPerSample", &FrameInfo::bitsPerSample)
      .field("componentCount", &FrameInfo::componentCount)
      .field("isSigned", &FrameInfo::isSigned);
  class_<JxlDecoderWasm>("JxlDecoder")
      .constructor<>()
      .function("getEncodedBuffer", &JxlDecoderWasm::getEncodedBuffer)
      .function("getDecodedBuffer", &JxlDecoderWasm::getDecodedBuffer)
      .function("getFrameInfo", &JxlDecoderWasm::getFrameInfo)
      .function("decode", &JxlDecoderWasm::decode);
}
