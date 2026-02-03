package to.holepunch.modules.mediasession

import android.net.Uri
import android.os.Bundle
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import androidx.media.MediaBrowserServiceCompat

class PearTubeMediaBrowserService : MediaBrowserServiceCompat() {
    override fun onCreate() {
        super.onCreate()
        android.util.Log.d("PearTubeMediaBrowserService", "onCreate")
        val session = MediaSessionRegistry.ensureSession(this)
        sessionToken = session.sessionToken
    }

    override fun onGetRoot(
        clientPackageName: String,
        clientUid: Int,
        rootHints: Bundle?
    ): BrowserRoot {
        android.util.Log.d(
            "PearTubeMediaBrowserService",
            "onGetRoot client=$clientPackageName uid=$clientUid hints=$rootHints"
        )
        return BrowserRoot("peartube_root", null)
    }

    override fun onLoadChildren(
        parentId: String,
        result: Result<MutableList<MediaBrowserCompat.MediaItem>>
    ) {
        android.util.Log.d("PearTubeMediaBrowserService", "onLoadChildren parentId=$parentId")
        val metadata = MediaSessionRegistry.getMetadata()
        if (metadata == null) {
            android.util.Log.d("PearTubeMediaBrowserService", "onLoadChildren: no metadata")
            result.sendResult(mutableListOf())
            return
        }

        val title = metadata.getString(MediaMetadataCompat.METADATA_KEY_TITLE)
        val artist = metadata.getString(MediaMetadataCompat.METADATA_KEY_ARTIST)
        val album = metadata.getString(MediaMetadataCompat.METADATA_KEY_ALBUM)
        val artBitmap = metadata.getBitmap(MediaMetadataCompat.METADATA_KEY_ART)
        val artUriString = metadata.getString(MediaMetadataCompat.METADATA_KEY_ART_URI)

        val description = MediaDescriptionCompat.Builder()
            .setMediaId("peartube_now_playing")
            .setTitle(title)
            .setSubtitle(artist)
            .setDescription(album)
            .setIconBitmap(artBitmap)
            .setIconUri(artUriString?.let { Uri.parse(it) })
            .build()

        val item = MediaBrowserCompat.MediaItem(description, MediaBrowserCompat.MediaItem.FLAG_PLAYABLE)
        android.util.Log.d("PearTubeMediaBrowserService", "onLoadChildren: returning now playing")
        result.sendResult(mutableListOf(item))
    }

    override fun onDestroy() {
        android.util.Log.d("PearTubeMediaBrowserService", "onDestroy")
        super.onDestroy()
    }
}
