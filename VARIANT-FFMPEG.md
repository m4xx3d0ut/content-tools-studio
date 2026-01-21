# Variant FFmpeg Commands

All commands run from `/home/m4xx3d0ut/Documents/PK/k1s/demo-content`.

## 1x (labeled_5s)

### Render overlays (no slug)

```bash
ffmpeg -y -i k1s-demo-0.1.0-0-2026-01-19_1080p.mp4 \
  -loop 1 -i overlays/ov_01.png \
  -loop 1 -i overlays/ov_02.png \
  -loop 1 -i overlays/ov_03.png \
  -loop 1 -i overlays/ov_04.png \
  -loop 1 -i overlays/ov_05.png \
  -loop 1 -i overlays/ov_06.png \
  -loop 1 -i overlays/ov_07.png \
  -loop 1 -i overlays/ov_08.png \
  -loop 1 -i overlays/ov_09.png \
  -loop 1 -i overlays/ov_10.png \
  -loop 1 -i overlays/ov_11.png \
  -loop 1 -i overlays/ov_12.png \
  -loop 1 -i overlays/ov_13.png \
  -loop 1 -i overlays/ov_14.png \
  -filter_complex_script filter_complex_full.txt \
  -map "[v14]" -t 247.233333 -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_noslug.mp4
```

## 1x (labeled_5s_arrows)

### Render overlays + arrows (no slug)

```bash
ffmpeg -y -i k1s-demo-0.1.0-0-2026-01-19_1080p.mp4 \
  -loop 1 -i overlays/ov_01.png \
  -loop 1 -i overlays/ov_02.png \
  -loop 1 -i overlays/ov_03.png \
  -loop 1 -i overlays/ov_04.png \
  -loop 1 -i overlays/ov_05.png \
  -loop 1 -i overlays/ov_06.png \
  -loop 1 -i overlays/ov_07.png \
  -loop 1 -i overlays/ov_08.png \
  -loop 1 -i overlays/ov_09.png \
  -loop 1 -i overlays/ov_10.png \
  -loop 1 -i overlays/ov_11.png \
  -loop 1 -i overlays/ov_12.png \
  -loop 1 -i overlays/ov_13.png \
  -loop 1 -i overlays/ov_14.png \
  -loop 1 -i k1s-directional-arrows/arrow-right-128x128.png \
  -filter_complex_script filter_complex_full_arrows.txt \
  -map "[v28]" -t 247.233333 -c:v libx264 -crf 18 -preset ultrafast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows_noslug.mp4
```

Note: `filter_complex_full_arrows.txt` uses right-pointing arrows on the right side, left-pointing arrows on the left side, and the two arrows in the Events/Logs panel point left.

### Add slug intro/outro

```bash
ffmpeg -y -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -i k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows_noslug.mp4 \
  -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -filter_complex "[0:v]fps=30,setsar=1[v0];[1:v]fps=30,setsar=1[v1];[2:v]fps=30,setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows.mp4
```

### Add slug intro/outro

```bash
ffmpeg -y -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -i k1s-demo-0.1.0-0-2026-01-19_labeled_5s_noslug.mp4 \
  -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -filter_complex "[0:v]fps=30,setsar=1[v0];[1:v]fps=30,setsar=1[v1];[2:v]fps=30,setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s.mp4
```

## 2x (labeled_5s_2x)

### Render overlays (no slug)

```bash
ffmpeg -y -i k1s-demo-0.1.0-0-2026-01-19_1080p.mp4 \
  -loop 1 -i overlays/ov_01.png \
  -loop 1 -i overlays/ov_02.png \
  -loop 1 -i overlays/ov_03.png \
  -loop 1 -i overlays/ov_04.png \
  -loop 1 -i overlays/ov_05.png \
  -loop 1 -i overlays/ov_06.png \
  -loop 1 -i overlays/ov_07.png \
  -loop 1 -i overlays/ov_08.png \
  -loop 1 -i overlays/ov_09.png \
  -loop 1 -i overlays/ov_10.png \
  -loop 1 -i overlays/ov_11.png \
  -loop 1 -i overlays/ov_12.png \
  -loop 1 -i overlays/ov_13.png \
  -loop 1 -i overlays/ov_14.png \
  -filter_complex_script filter_complex_full_2x.txt \
  -map "[v14]" -t 123.6166665 -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_2x_noslug.mp4
```

## 2x (labeled_5s_arrows_2x)

### Render overlays + arrows (no slug)

```bash
ffmpeg -y -i k1s-demo-0.1.0-0-2026-01-19_1080p.mp4 \
  -loop 1 -i overlays/ov_01.png \
  -loop 1 -i overlays/ov_02.png \
  -loop 1 -i overlays/ov_03.png \
  -loop 1 -i overlays/ov_04.png \
  -loop 1 -i overlays/ov_05.png \
  -loop 1 -i overlays/ov_06.png \
  -loop 1 -i overlays/ov_07.png \
  -loop 1 -i overlays/ov_08.png \
  -loop 1 -i overlays/ov_09.png \
  -loop 1 -i overlays/ov_10.png \
  -loop 1 -i overlays/ov_11.png \
  -loop 1 -i overlays/ov_12.png \
  -loop 1 -i overlays/ov_13.png \
  -loop 1 -i overlays/ov_14.png \
  -loop 1 -i k1s-directional-arrows/arrow-right-128x128.png \
  -filter_complex_script filter_complex_full_arrows_2x.txt \
  -map "[v28]" -t 123.6166665 -c:v libx264 -crf 18 -preset ultrafast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows_2x_noslug.mp4
```

### Add slug intro/outro

```bash
ffmpeg -y -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -i k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows_2x_noslug.mp4 \
  -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -filter_complex "[0:v]fps=30,setsar=1[v0];[1:v]fps=30,setsar=1[v1];[2:v]fps=30,setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows_2x.mp4
```

### Add slug intro/outro

```bash
ffmpeg -y -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -i k1s-demo-0.1.0-0-2026-01-19_labeled_5s_2x_noslug.mp4 \
  -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -filter_complex "[0:v]fps=30,setsar=1[v0];[1:v]fps=30,setsar=1[v1];[2:v]fps=30,setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_2x.mp4
```
