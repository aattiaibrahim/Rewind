//! Windows Graphics Capture of one monitor (what OBS uses on Windows 10/11).
//! Each new frame is copied (GPU to GPU) into `latest`, stamped with the time
//! it was captured on the shared high-precision clock.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Graphics::Direct3D11::{D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, ID3D11Texture2D};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::core::{Interface, Result, factory};

use super::gpu::Gpu;

pub struct Latest {
    pub texture: ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
    /// When the newest frame was captured, and how many have arrived.
    pub captured_at: Option<Instant>,
    pub frames: u64,
    /// The monitor changed size (resolution change): capture must restart.
    pub size_changed: bool,
}

pub struct Capture {
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    pub latest: Arc<Mutex<Latest>>,
}

impl Capture {
    pub fn start(gpu: &Gpu, monitor: HMONITOR, cursor: bool) -> Result<Capture> {
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = unsafe { interop.CreateForMonitor(monitor)? };
        let size = item.Size()?;
        let (w, h) = (size.Width as u32, size.Height as u32);

        let dxgi: IDXGIDevice = gpu.device.cast()?;
        let winrt_device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )?;
        let session = pool.CreateCaptureSession(&item)?;
        let _ = session.SetIsCursorCaptureEnabled(cursor);
        // No yellow "being captured" border (Windows 11).
        let _ = session.SetIsBorderRequired(false);

        // The video processor needs its input to be render-target capable.
        let texture = gpu.texture(w, h, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET)?;
        let latest = Arc::new(Mutex::new(Latest { texture, width: w, height: h, captured_at: None, frames: 0, size_changed: false }));

        let ctx = gpu.context.clone();
        let l = latest.clone();
        pool.FrameArrived(&TypedEventHandler::new(move |sender: windows::core::Ref<Direct3D11CaptureFramePool>, _| {
            let Some(pool) = sender.as_ref() else { return Ok(()) };
            let frame = pool.TryGetNextFrame()?;
            let now = Instant::now();
            let content = frame.ContentSize()?;
            let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
            let tex: ID3D11Texture2D = unsafe { access.GetInterface()? };
            let mut latest = l.lock().unwrap();
            if content.Width as u32 != latest.width || content.Height as u32 != latest.height {
                latest.size_changed = true;
                return Ok(());
            }
            unsafe { ctx.CopyResource(&latest.texture, &tex) };
            latest.captured_at = Some(now);
            latest.frames += 1;
            Ok(())
        }))?;
        session.StartCapture()?;
        Ok(Capture { _item: item, pool, session, latest })
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}
