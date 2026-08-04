package com.kardanov.agstatus

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.kardanov.agstatus.ui.BoardScreen
import com.kardanov.agstatus.ui.HistoryScreen
import com.kardanov.agstatus.ui.PairSheet
import com.kardanov.agstatus.ui.ScannerScreen
import com.kardanov.agstatus.ui.SettingsScreen
import com.kardanov.agstatus.ui.WelcomeScreen
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Screenshot hooks, mirroring the iOS app's AGSTATUS_DEMO / AGSTATUS_OPEN_HISTORY
 * launch environment:
 *
 *     adb shell am start -n com.kardanov.agstatus/.MainActivity \
 *         --ez agstatus_demo true --ez agstatus_open_history true
 */
private const val EXTRA_DEMO = "agstatus_demo"
private const val EXTRA_OPEN_HISTORY = "agstatus_open_history"

/** How long the screenshot hook waits for a board to produce its first session. */
private const val OPEN_HISTORY_TIMEOUT_MS = 4_000L

class MainActivity : ComponentActivity() {

    private val store: SessionStore by viewModels()

    /** True once the activity has been backgrounded at least once. */
    private var wasStopped = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The board is always dark, so the system bar icons are always light.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )

        // Seeded before the first composition so the board is already on screen.
        if (BuildConfig.DEBUG &&
            savedInstanceState == null &&
            intent.getBooleanExtra(EXTRA_DEMO, false)
        ) {
            store.startDemo()
        }
        val openHistory = BuildConfig.DEBUG && intent.getBooleanExtra(EXTRA_OPEN_HISTORY, false)

        setContent {
            AgStatusTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = Theme.background) {
                    AgStatusApp(store = store, openFirstHistory = openHistory)
                }
            }
        }
    }

    // A suspended SSE socket dies silently; reconnect on return so the board never
    // shows stale data under a green dot — and release the server's per-board
    // connection slot while backgrounded.

    override fun onStart() {
        super.onStart()
        if (wasStopped &&
            store.board.value != null &&
            !store.isDemo &&
            store.connection.value != SessionStore.Connection.BOARD_GONE
        ) {
            store.connect()
        }
        wasStopped = false
    }

    override fun onStop() {
        super.onStop()
        wasStopped = true
        if (!store.isDemo && store.connection.value != SessionStore.Connection.BOARD_GONE) {
            store.disconnect()
        }
    }
}

private object Route {
    const val WELCOME = "welcome"
    const val BOARD = "board"
    const val SETTINGS = "settings"
    const val SCANNER = "scanner"
    const val ARG_SESSION_ID = "sessionId"
    const val HISTORY = "history/{$ARG_SESSION_ID}"

    fun history(sessionId: String): String = "history/${Uri.encode(sessionId)}"
}

@Composable
private fun AgStatusApp(
    store: SessionStore,
    openFirstHistory: Boolean,
) {
    val navController = rememberNavController()
    val board by store.board.collectAsState()
    val connection by store.connection.collectAsState()
    var showPairSheet by remember { mutableStateOf(false) }

    val showsBoard = board != null || connection == SessionStore.Connection.DEMO
    val startDestination = remember {
        if (store.board.value != null || store.isDemo) Route.BOARD else Route.WELCOME
    }

    // Adopting or leaving a board swaps the whole screen, exactly like the iOS
    // RootView switch between the welcome flow and the board.
    LaunchedEffect(showsBoard) {
        val current = navController.currentDestination?.route
        if (showsBoard) {
            if (current == Route.WELCOME) {
                navController.navigate(Route.BOARD) {
                    popUpTo(Route.WELCOME) { inclusive = true }
                }
            }
        } else if (current != null && current != Route.WELCOME) {
            showPairSheet = false
            navController.navigate(Route.WELCOME) {
                popUpTo(navController.graph.id) { inclusive = true }
            }
        }
    }

    if (openFirstHistory) {
        OpenFirstHistoryEffect(store, navController)
    }

    Box(modifier = Modifier.fillMaxSize()) {
        NavHost(navController = navController, startDestination = startDestination) {
            composable(Route.WELCOME) {
                WelcomeScreen(store = store)
            }
            composable(Route.BOARD) {
                BoardScreen(
                    store = store,
                    onOpenHistory = { sessionId -> navController.navigate(Route.history(sessionId)) },
                    onOpenSettings = { navController.navigate(Route.SETTINGS) },
                    onOpenPair = { showPairSheet = true },
                )
            }
            composable(
                route = Route.HISTORY,
                arguments = listOf(navArgument(Route.ARG_SESSION_ID) { type = NavType.StringType }),
            ) { entry ->
                HistoryScreen(
                    store = store,
                    sessionId = entry.arguments?.getString(Route.ARG_SESSION_ID).orEmpty(),
                    onBack = { navController.popBackStack() },
                )
            }
            composable(Route.SETTINGS) {
                SettingsScreen(store = store, onBack = { navController.popBackStack() })
            }
            composable(Route.SCANNER) {
                ScannerScreen(
                    onResult = { scanned ->
                        Board.parse(scanned)?.let(store::adopt)
                        navController.popBackStack()
                    },
                    onCancel = { navController.popBackStack() },
                )
            }
        }

        if (showPairSheet) {
            PairSheet(store = store, onDismiss = { showPairSheet = false })
        }
    }
}

/**
 * Debug-only deep link so screenshot automation can reach the history screen,
 * which cannot be tapped from `adb shell am start`.
 */
@Composable
private fun OpenFirstHistoryEffect(store: SessionStore, navController: NavHostController) {
    LaunchedEffect(Unit) {
        // Demo sessions are seeded synchronously; a real board arrives over SSE.
        val sessions = withTimeoutOrNull(OPEN_HISTORY_TIMEOUT_MS) {
            store.sessions.first { it.isNotEmpty() }
        }
        val first = sessions?.firstOrNull() ?: return@LaunchedEffect
        if (navController.currentDestination?.route == Route.BOARD) {
            navController.navigate(Route.history(first.id))
        }
    }
}
