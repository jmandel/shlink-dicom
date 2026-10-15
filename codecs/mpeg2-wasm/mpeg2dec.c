// MPEG-2 video decoding for the browser: FFmpeg's demuxers (MPEG-PS, MPEG-TS, raw MPEG video) and
// MPEG-1/2 decoder behind five functions. Input is read through a JavaScript callback
// (Module.readAt(pos, ptr, len) → bytes read), so the stream never has to fit in wasm memory.
//
//   dec_open(size)          0, or a negative AVERROR
//   dec_info()              pointer to doubles: width, height, fps, duration s, sar num, sar den, pix fmt
//   dec_next()              pointer to the frame record (see FRAME_*), or 0 at the end; errors skip
//   dec_seek(seconds)       seeks to the key frame at or before `seconds` (negative: the first byte)
//   dec_close()
#include <emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>

EM_JS(int, js_read_at, (double pos, uint8_t *buf, int len), { return Module.readAt(pos, buf, len); });

static AVFormatContext *fmt;
static AVIOContext *io;
static AVCodecContext *dec;
static AVPacket *pkt;
static AVFrame *frm;
static int vstream = -1;
static double size, pos;
static double info[8];
static double rec[16];
static int draining;

static int io_read(void *opaque, uint8_t *buf, int len) {
  if (pos >= size) return AVERROR_EOF;
  int n = js_read_at(pos, buf, len);
  if (n <= 0) return AVERROR_EOF;
  pos += n;
  return n;
}

static int64_t io_seek(void *opaque, int64_t offset, int whence) {
  whence &= ~AVSEEK_FORCE;
  if (whence == AVSEEK_SIZE) return (int64_t)size;
  double p = whence == SEEK_SET ? (double)offset : whence == SEEK_CUR ? pos + offset : size + offset;
  if (p < 0 || p > size) return AVERROR(EINVAL);
  pos = p;
  return (int64_t)p;
}

EMSCRIPTEN_KEEPALIVE void dec_close(void) {
  if (dec) avcodec_free_context(&dec);
  if (fmt) avformat_close_input(&fmt);
  if (io) {
    av_freep(&io->buffer);
    avio_context_free(&io);
  }
  if (pkt) av_packet_free(&pkt);
  if (frm) av_frame_free(&frm);
  vstream = -1;
  draining = 0;
}

EMSCRIPTEN_KEEPALIVE int dec_open(double total) {
  dec_close();
  av_log_set_level(AV_LOG_FATAL);
  size = total;
  pos = 0;
  const int bufsize = 1 << 16;
  uint8_t *buf = av_malloc(bufsize);
  io = avio_alloc_context(buf, bufsize, 0, NULL, io_read, NULL, io_seek);
  fmt = avformat_alloc_context();
  fmt->pb = io;
  fmt->flags |= AVFMT_FLAG_CUSTOM_IO;
  int r = avformat_open_input(&fmt, NULL, NULL, NULL);
  if (r < 0) return r;
  r = avformat_find_stream_info(fmt, NULL);
  if (r < 0) return r;
  vstream = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
  if (vstream < 0) return vstream;
  for (unsigned i = 0; i < fmt->nb_streams; i++) fmt->streams[i]->discard = (int)i == vstream ? AVDISCARD_DEFAULT : AVDISCARD_ALL;
  AVStream *st = fmt->streams[vstream];
  const AVCodec *codec = avcodec_find_decoder(st->codecpar->codec_id);
  if (!codec) return AVERROR_DECODER_NOT_FOUND;
  dec = avcodec_alloc_context3(codec);
  avcodec_parameters_to_context(dec, st->codecpar);
  r = avcodec_open2(dec, codec, NULL);
  if (r < 0) return r;
  pkt = av_packet_alloc();
  frm = av_frame_alloc();
  AVRational fr = av_guess_frame_rate(fmt, st, NULL);
  info[0] = dec->width;
  info[1] = dec->height;
  info[2] = fr.den ? av_q2d(fr) : 0;
  info[3] = fmt->duration > 0 ? fmt->duration / (double)AV_TIME_BASE : 0;
  info[4] = st->sample_aspect_ratio.num ? st->sample_aspect_ratio.num : dec->sample_aspect_ratio.num;
  info[5] = st->sample_aspect_ratio.den ? st->sample_aspect_ratio.den : dec->sample_aspect_ratio.den;
  info[6] = dec->pix_fmt;
  info[7] = st->codecpar->codec_id == AV_CODEC_ID_MPEG2VIDEO ? 2 : 1;
  return 0;
}

EMSCRIPTEN_KEEPALIVE double *dec_info(void) { return info; }

// Frame record: [0..2] plane pointers (Y, U, V), [3..5] line sizes, [6] width, [7] height,
// [8] pts in seconds from the stream start (NaN if unknown), [9] key frame, [10] pixel format,
// [11] interlaced, [12] top field first.
static double *frame_record(void) {
  AVStream *st = fmt->streams[vstream];
  int64_t ts = frm->best_effort_timestamp;
  int64_t start = st->start_time != AV_NOPTS_VALUE ? st->start_time : 0;
  for (int i = 0; i < 3; i++) {
    rec[i] = (double)(uintptr_t)frm->data[i];
    rec[3 + i] = frm->linesize[i];
  }
  rec[6] = frm->width;
  rec[7] = frm->height;
  rec[8] = ts == AV_NOPTS_VALUE ? NAN : (ts - start) * av_q2d(st->time_base);
  rec[9] = (frm->flags & AV_FRAME_FLAG_KEY) ? 1 : 0;
  rec[10] = frm->format;
  rec[11] = (frm->flags & AV_FRAME_FLAG_INTERLACED) ? 1 : 0;
  rec[12] = (frm->flags & AV_FRAME_FLAG_TOP_FIELD_FIRST) ? 1 : 0;
  return rec;
}

EMSCRIPTEN_KEEPALIVE double *dec_next(void) {
  for (;;) {
    int r = avcodec_receive_frame(dec, frm);
    if (r == 0) return frame_record();
    if (r == AVERROR_EOF) return 0;
    if (r != AVERROR(EAGAIN)) return 0;
    if (draining) return 0;
    r = av_read_frame(fmt, pkt);
    if (r < 0) {
      draining = 1;
      avcodec_send_packet(dec, NULL);
      continue;
    }
    if (pkt->stream_index == vstream) avcodec_send_packet(dec, pkt);  // decode errors: skip the packet
    av_packet_unref(pkt);
  }
}

EMSCRIPTEN_KEEPALIVE int dec_seek(double seconds) {
  if (seconds < 0) {
    // Back to the first byte, then decode forward.
    int r = avformat_seek_file(fmt, -1, INT64_MIN, 0, 0, AVSEEK_FLAG_BYTE);
    avcodec_flush_buffers(dec);
    draining = 0;
    return r < 0 ? r : 0;
  }
  AVStream *st = fmt->streams[vstream];
  int64_t start = st->start_time != AV_NOPTS_VALUE ? st->start_time : 0;
  int64_t ts = start + (int64_t)(seconds / av_q2d(st->time_base));
  int r = av_seek_frame(fmt, vstream, ts, AVSEEK_FLAG_BACKWARD);
  if (r < 0) r = avformat_seek_file(fmt, vstream, INT64_MIN, ts, ts, 0);
  if (r < 0) {
    // No timestamp seeking (some raw streams): restart from the beginning.
    r = avio_seek(fmt->pb, 0, SEEK_SET) < 0 ? -1 : avformat_seek_file(fmt, -1, INT64_MIN, 0, 0, AVSEEK_FLAG_BYTE);
  }
  avcodec_flush_buffers(dec);
  draining = 0;
  return r < 0 ? r : 0;
}
