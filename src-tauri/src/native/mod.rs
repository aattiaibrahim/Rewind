//! Rewind's native recording engine: Windows Graphics Capture → GPU colour
//! convert/resize → NVENC, everything on the GPU and stamped on one clock.

pub mod capture;
pub mod gpu;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use windows::Win32::Graphics::Direct3D11::D3D11_BIND_RENDER_TARGET;
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12;

    fn primary() -> String {
        crate::monitors::list().into_iter().find(|m| m.primary).expect("a monitor").name
    }

    /// Writes a 24-bit BMP (tests only) so the captured image can be looked at.
    fn write_bmp(path: &std::path::Path, w: u32, h: u32, bgra: &[u8]) {
        let row = (w * 3).div_ceil(4) * 4;
        let mut f = Vec::new();
        let size = 54 + row * h;
        f.extend_from_slice(b"BM");
        f.extend_from_slice(&size.to_le_bytes());
        f.extend_from_slice(&[0; 4]);
        f.extend_from_slice(&54u32.to_le_bytes());
        f.extend_from_slice(&40u32.to_le_bytes());
        f.extend_from_slice(&(w as i32).to_le_bytes());
        f.extend_from_slice(&(-(h as i32)).to_le_bytes());
        f.extend_from_slice(&1u16.to_le_bytes());
        f.extend_from_slice(&24u16.to_le_bytes());
        f.extend_from_slice(&[0; 24]);
        for y in 0..h as usize {
            for x in 0..w as usize {
                let i = (y * w as usize + x) * 4;
                f.extend_from_slice(&bgra[i..i + 3]);
            }
            f.resize(f.len() + (row - w * 3) as usize, 0);
        }
        std::fs::write(path, f).unwrap();
    }

    /// cargo test native_capture -- --ignored --nocapture
    #[test]
    #[ignore]
    fn native_capture_frames_and_converts() {
        let (adapter, hmon, name) = gpu::find_output(&primary()).expect("output");
        let g = gpu::Gpu::new(&adapter, name.clone()).unwrap();
        println!("GPU: {name}");
        let cap = capture::Capture::start(&g, hmon, true).unwrap();
        let start = Instant::now();
        std::thread::sleep(Duration::from_millis(1500));
        let (frames, w, h, tex) = {
            let l = cap.latest.lock().unwrap();
            (l.frames, l.width, l.height, l.texture.clone())
        };
        println!("captured {frames} frames in {:?} at {w}x{h}", start.elapsed());
        assert!(frames > 0, "no frames arrived");

        let (_, _, px) = g.read_bgra(&tex).unwrap();
        let out = std::env::temp_dir().join("rewind-native-capture.bmp");
        write_bmp(&out, w, h, &px);
        println!("frame saved to {}", out.display());

        // GPU convert to NV12 at native, 1280x720 and 3840x2160.
        for (ow, oh) in [(w, h), (1280, 720), (3840, 2160)] {
            let conv = gpu::Converter::new(&g, w, h, ow, oh, 60).expect("converter");
            let dst = g.texture(ow, oh, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET).expect("nv12 texture");
            let t = Instant::now();
            for _ in 0..60 {
                conv.convert(&tex, &dst).expect("convert");
            }
            unsafe { g.context.Flush() };
            println!("convert {w}x{h} -> NV12 {ow}x{oh}: 60 frames queued in {:?}", t.elapsed());
        }
    }
}
