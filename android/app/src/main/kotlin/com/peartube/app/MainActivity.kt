package com.peartube.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import com.peartube.app.player.PlayerHost
import com.peartube.app.ui.App
import com.peartube.app.ui.PearTubeTheme

class MainActivity : ComponentActivity() {
    private lateinit var player: PlayerHost

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val model = (application as PearTubeApp).model
        if (savedInstanceState == null) {
            handleIncomingIntent(intent, model)
        }
        player = PlayerHost(this)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        setContent { PearTubeTheme { App(model, player) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val model = (application as PearTubeApp).model
        handleIncomingIntent(intent, model)
    }

    private fun handleIncomingIntent(intent: Intent?, model: AppModel) {
        if (intent == null) return
        if (intent.action == Intent.ACTION_SEND) {
            val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
            val sharedSubject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty()
            val candidate = when {
                extractSharedUrl(sharedText) != null -> sharedText
                extractSharedUrl(sharedSubject) != null -> sharedSubject
                sharedText.isNotBlank() -> sharedText
                else -> sharedSubject
            }
            if (candidate.isNotBlank()) {
                model.handleSharedText(candidate)
            }
            return
        }
        intent.dataString?.takeIf { it.isNotBlank() }?.let { uri ->
            model.handleSharedText(uri)
        }
    }

    override fun onDestroy() {
        player.destroy()
        super.onDestroy()
    }
}
