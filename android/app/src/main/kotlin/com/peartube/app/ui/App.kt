package com.peartube.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.peartube.app.AppModel
import com.peartube.app.Screen
import com.peartube.app.player.PlayerHost

@Composable
fun App(model: AppModel, player: PlayerHost) {
    val screen by model.screen.collectAsState()
    val error by model.error.collectAsState()
    val notice by model.notice.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(notice) {
        notice?.let { snackbar.showSnackbar(it); model.notice.value = null }
    }
    BackHandler(enabled = screen != Screen.List) {
        if (screen is Screen.Cast) model.cancelCast() else model.screen.value = Screen.List
    }
    val clearBehind = screen is Screen.Play
    Box(Modifier.fillMaxSize().then(if (clearBehind) Modifier else Modifier.background(Bg))) {
        Column(Modifier.fillMaxSize()) {
            error?.let { message ->
                Row(Modifier.fillMaxWidth().statusBarsPadding().background(Danger.copy(alpha = .16f)).padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(message, color = Ink, modifier = Modifier.weight(1f).padding(vertical = 10.dp))
                    CinemaIcon(CloseIcon, "Dismiss error", Ink) { model.error.value = null }
                }
            }
            AnimatedContent(
                targetState = screen,
                transitionSpec = {
                    val touchesSurface = initialState is Screen.Play || targetState is Screen.Play
                    if (touchesSurface) EnterTransition.None togetherWith ExitTransition.None
                    else fadeIn(tween(200)) togetherWith fadeOut(tween(150))
                },
                contentKey = { when (it) { is Screen.Cast -> Screen.List; is Screen.Play -> Screen.Play::class; else -> it } },
                modifier = Modifier.weight(1f), label = "Cinema screens",
            ) { current ->
                when (current) {
                    Screen.List -> ListScreen(model)
                    Screen.Settings -> SettingsScreen(model)
                    is Screen.Cast -> Box(Modifier.fillMaxSize()) {
                        ListScreen(model)
                        CastSheetScreen(model)
                    }
                    is Screen.Play -> key(current.entry.key) { PlayScreen(model, player, current.entry, current.startPositionMs) }
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(16.dp))
    }
}
