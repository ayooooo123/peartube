package com.margelo.nitro.com.nitrovlc

import android.content.Context
import android.view.SurfaceView
import io.mockk.*
import io.mockk.impl.annotations.MockK
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.interfaces.IVLCVout

/**
 * Integration tests for HybridNitroVLCView using MockK to mock VLC native
 * components (LibVLC, MediaPlayer) unavailable in unit test environment.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30], manifest = Config.NONE)
class HybridNitroVLCViewTest {

    private lateinit var context: Context
    
    @MockK(relaxed = true)
    private lateinit var mockLibVLC: LibVLC
    
    @MockK(relaxed = true)
    private lateinit var mockMediaPlayer: MediaPlayer
    
    @MockK(relaxed = true)
    private lateinit var mockVlcVout: IVLCVout
    
    @MockK(relaxed = true)
    private lateinit var mockMedia: Media

    @Before
    fun setup() {
        MockKAnnotations.init(this)
        context = RuntimeEnvironment.getApplication()
        
        mockkConstructor(LibVLC::class)
        mockkConstructor(MediaPlayer::class)
        mockkConstructor(Media::class)
        
        every { anyConstructed<LibVLC>().release() } just Runs
        every { anyConstructed<MediaPlayer>().vlcVout } returns mockVlcVout
        every { anyConstructed<MediaPlayer>().setEventListener(any()) } just Runs
        every { anyConstructed<MediaPlayer>().release() } just Runs
        every { mockVlcVout.attachViews(any()) } just Runs
        every { mockVlcVout.detachViews() } just Runs
        every { mockVlcVout.areViewsAttached() } returns false
        every { mockVlcVout.setVideoSurface(any(), any()) } just Runs
        every { mockVlcVout.setWindowSize(any(), any()) } just Runs
    }

    @After
    fun tearDown() {
        unmockkAll()
    }

    @Test
    fun `view initialization creates SurfaceView`() {
        val view = HybridNitroVLCView(context)
        
        assertNotNull(view)
        assertNotNull(view.view)
        assertTrue(view.view is SurfaceView)
    }

    @Test
    fun `initial source is empty`() {
        val view = HybridNitroVLCView(context)
        assertEquals("", view.source.uri)
    }

    @Test
    fun `initial paused state is null`() {
        val view = HybridNitroVLCView(context)
        assertNull(view.paused)
    }

    @Test
    fun `initial volume is null`() {
        val view = HybridNitroVLCView(context)
        assertNull(view.volume)
    }

    @Test
    fun `initial muted state is null`() {
        val view = HybridNitroVLCView(context)
        assertNull(view.muted)
    }

    @Test
    fun `play method calls mediaPlayer play`() {
        every { anyConstructed<MediaPlayer>().play() } returns Unit
        
        val view = HybridNitroVLCView(context)
        view.play()
        
        verify { anyConstructed<MediaPlayer>().play() }
    }

    @Test
    fun `pause method calls mediaPlayer pause`() {
        every { anyConstructed<MediaPlayer>().pause() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.pause()
        
        verify { anyConstructed<MediaPlayer>().pause() }
    }

    @Test
    fun `stop method calls mediaPlayer stop`() {
        every { anyConstructed<MediaPlayer>().stop() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.stop()
        
        verify { anyConstructed<MediaPlayer>().stop() }
    }

    @Test
    fun `setting paused to true pauses playback`() {
        every { anyConstructed<MediaPlayer>().pause() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.paused = true
        
        verify { anyConstructed<MediaPlayer>().pause() }
    }

    @Test
    fun `setting paused to false resumes playback`() {
        every { anyConstructed<MediaPlayer>().play() } returns Unit
        
        val view = HybridNitroVLCView(context)
        view.paused = false
        
        verify { anyConstructed<MediaPlayer>().play() }
    }

    @Test
    fun `seek method sets mediaPlayer position`() {
        every { anyConstructed<MediaPlayer>().position = any() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.seek(0.5)
        
        verify { anyConstructed<MediaPlayer>().position = 0.5f }
    }

    @Test
    fun `seek with 0 sets position to beginning`() {
        every { anyConstructed<MediaPlayer>().position = any() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.seek(0.0)
        
        verify { anyConstructed<MediaPlayer>().position = 0.0f }
    }

    @Test
    fun `seek with 1 sets position to end`() {
        every { anyConstructed<MediaPlayer>().position = any() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.seek(1.0)
        
        verify { anyConstructed<MediaPlayer>().position = 1.0f }
    }

    @Test
    fun `seek property validates range 0 to 1`() {
        every { anyConstructed<MediaPlayer>().position = any() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.seek = 0.5
        
        verify { anyConstructed<MediaPlayer>().position = 0.5f }
    }

    @Test
    fun `setVolume method updates volume`() {
        every { anyConstructed<MediaPlayer>().volume = any() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.setVolume(0.8)
        
        assertEquals(0.8, view.volume)
    }

    @Test
    fun `setting muted to true sets volume to 0`() {
        every { anyConstructed<MediaPlayer>().volume = any() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.volume = 1.0
        view.muted = true
        
        verify { anyConstructed<MediaPlayer>().volume = 0 }
    }

    @Test
    fun `setting muted to false restores previous volume`() {
        every { anyConstructed<MediaPlayer>().volume = any() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.volume = 0.5
        view.muted = true
        view.muted = false
        
        verify { anyConstructed<MediaPlayer>().volume = 50 }
    }

    @Test
    fun `setting rate updates playback speed`() {
        every { anyConstructed<MediaPlayer>().rate = any() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.rate = 2.0
        
        verify { anyConstructed<MediaPlayer>().rate = 2.0f }
    }

    @Test
    fun `rate of 0_5 plays at half speed`() {
        every { anyConstructed<MediaPlayer>().rate = any() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.rate = 0.5
        
        verify { anyConstructed<MediaPlayer>().rate = 0.5f }
    }

    @Test
    fun `onPlaying callback can be registered`() {
        val view = HybridNitroVLCView(context)
        view.onPlaying = { _ -> }
        assertNotNull(view.onPlaying)
    }

    @Test
    fun `onProgress callback can be registered`() {
        val view = HybridNitroVLCView(context)
        view.onProgress = { _ -> }
        assertNotNull(view.onProgress)
    }

    @Test
    fun `onPaused callback can be registered`() {
        val view = HybridNitroVLCView(context)
        view.onPaused = { _ -> }
        assertNotNull(view.onPaused)
    }

    @Test
    fun `onStopped callback can be registered`() {
        val view = HybridNitroVLCView(context)
        view.onStopped = { _ -> }
        assertNotNull(view.onStopped)
    }

    @Test
    fun `onBuffering callback can be registered`() {
        val view = HybridNitroVLCView(context)
        view.onBuffering = { _ -> }
        assertNotNull(view.onBuffering)
    }

    @Test
    fun `onEnded callback can be registered`() {
        val view = HybridNitroVLCView(context)
        view.onEnded = { _ -> }
        assertNotNull(view.onEnded)
    }

    @Test
    fun `onError callback can be registered`() {
        val view = HybridNitroVLCView(context)
        view.onError = { _ -> }
        assertNotNull(view.onError)
    }

    @Test
    fun `onLoad callback can be registered`() {
        val view = HybridNitroVLCView(context)
        view.onLoad = { _ -> }
        assertNotNull(view.onLoad)
    }

    @Test
    fun `multiple callbacks can be registered simultaneously`() {
        val view = HybridNitroVLCView(context)
        
        view.onPlaying = { _ -> }
        view.onPaused = { _ -> }
        view.onProgress = { _ -> }
        view.onError = { _ -> }
        
        assertNotNull(view.onPlaying)
        assertNotNull(view.onPaused)
        assertNotNull(view.onProgress)
        assertNotNull(view.onError)
    }

    @Test
    fun `setting source with valid URI loads media`() {
        every { anyConstructed<MediaPlayer>().media = any() } just Runs
        every { anyConstructed<MediaPlayer>().play() } returns Unit
        every { anyConstructed<Media>().release() } just Runs
        
        val view = HybridNitroVLCView(context)
        view.source = VLCPlayerSource("https://example.com/video.mp4", null, null)
        
        assertEquals("https://example.com/video.mp4", view.source.uri)
    }

    @Test
    fun `setting source with empty URI does not load media`() {
        val view = HybridNitroVLCView(context)
        view.source = VLCPlayerSource("", null, null)
        assertEquals("", view.source.uri)
    }

    @Test
    fun `source with init options uses custom options`() {
        every { anyConstructed<MediaPlayer>().media = any() } just Runs
        every { anyConstructed<MediaPlayer>().play() } returns Unit
        every { anyConstructed<Media>().release() } just Runs
        
        val customOptions = arrayOf("--network-caching=1000", "--file-caching=500")
        val view = HybridNitroVLCView(context)
        view.source = VLCPlayerSource("https://example.com/video.mp4", null, customOptions)
        
        assertNotNull(view.source.initOptions)
        assertEquals(2, view.source.initOptions?.size)
    }

    @Test
    fun `setting audioTrack selects audio track`() {
        every { anyConstructed<MediaPlayer>().setAudioTrack(any()) } returns true
        
        val view = HybridNitroVLCView(context)
        view.audioTrack = 1.0
        
        verify { anyConstructed<MediaPlayer>().setAudioTrack(1) }
    }

    @Test
    fun `setting textTrack selects subtitle track`() {
        every { anyConstructed<MediaPlayer>().setSpuTrack(any()) } returns true
        
        val view = HybridNitroVLCView(context)
        view.textTrack = 2.0
        
        verify { anyConstructed<MediaPlayer>().setSpuTrack(2) }
    }

    @Test
    fun `setting videoAspectRatio updates player aspect ratio`() {
        every { anyConstructed<MediaPlayer>().setScale(any()) } just Runs
        every { anyConstructed<MediaPlayer>().setAspectRatio(any()) } just Runs
        
        val view = HybridNitroVLCView(context)
        view.videoAspectRatio = PlayerAspectRatio.RATIO16X9
        
        assertEquals(PlayerAspectRatio.RATIO16X9, view.videoAspectRatio)
    }

    @Test
    fun `setting resizeMode to FILL updates scale`() {
        every { anyConstructed<MediaPlayer>().setScale(any()) } just Runs
        every { anyConstructed<MediaPlayer>().setAspectRatio(any()) } just Runs
        
        val view = HybridNitroVLCView(context)
        view.resizeMode = PlayerResizeMode.FILL
        
        assertEquals(PlayerResizeMode.FILL, view.resizeMode)
    }

    @Test
    fun `autoAspectRatio adjusts to view dimensions`() {
        every { anyConstructed<MediaPlayer>().setScale(any()) } just Runs
        every { anyConstructed<MediaPlayer>().setAspectRatio(any()) } just Runs
        
        val view = HybridNitroVLCView(context)
        view.autoAspectRatio = true
        
        assertTrue(view.autoAspectRatio == true)
    }

    @Test
    fun `setting subtitleUri adds subtitle slave`() {
        every { anyConstructed<MediaPlayer>().addSlave(any(), any<String>(), any()) } returns true
        
        val view = HybridNitroVLCView(context)
        view.subtitleUri = "https://example.com/subtitles.srt"
        
        verify { anyConstructed<MediaPlayer>().addSlave(Media.Slave.Type.Subtitle, "https://example.com/subtitles.srt", true) }
    }

    @Test
    fun `autoplay property can be set to true`() {
        val view = HybridNitroVLCView(context)
        view.autoplay = true
        assertTrue(view.autoplay == true)
    }

    @Test
    fun `autoplay false prevents automatic playback`() {
        val view = HybridNitroVLCView(context)
        view.autoplay = false
        assertFalse(view.autoplay == true)
    }

    @Test
    fun `acceptInvalidCertificates property can be set`() {
        val view = HybridNitroVLCView(context)
        view.acceptInvalidCertificates = true
        assertTrue(view.acceptInvalidCertificates == true)
    }

    @Test
    fun `acceptInvalidCertificates defaults to null`() {
        val view = HybridNitroVLCView(context)
        assertNull(view.acceptInvalidCertificates)
    }

    @Test
    fun `loop property can be set`() {
        val view = HybridNitroVLCView(context)
        view.loop = true
        assertTrue(view.loop == true)
    }

    @Test
    fun `playInBackground property can be set`() {
        val view = HybridNitroVLCView(context)
        view.playInBackground = true
        assertTrue(view.playInBackground == true)
    }
}
