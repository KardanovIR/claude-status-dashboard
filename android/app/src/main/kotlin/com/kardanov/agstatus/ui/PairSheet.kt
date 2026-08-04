package com.kardanov.agstatus.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.kardanov.agstatus.ApiException
import com.kardanov.agstatus.Board
import com.kardanov.agstatus.PairCode
import com.kardanov.agstatus.SessionStore
import com.kardanov.agstatus.Theme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale

private sealed interface PairPhase {
    data object Loading : PairPhase
    data class Ready(val code: PairCode, val expiresAtMillis: Long) : PairPhase
    data class Failed(val message: String) : PairPhase
}

/** Shows a fresh pairing code, its countdown, and the one command to run. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairSheet(store: SessionStore, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val board by store.board.collectAsState()
    val scope = rememberCoroutineScope()

    var phase by remember { mutableStateOf<PairPhase>(PairPhase.Loading) }
    var copied by remember { mutableStateOf(false) }
    var nowMillis by remember { mutableLongStateOf(System.currentTimeMillis()) }

    fun load(forceNew: Boolean) {
        phase = PairPhase.Loading
        copied = false
        scope.launch { phase = fetchPairPhase(store, forceNew) }
    }

    LaunchedEffect(Unit) { phase = fetchPairPhase(store, forceNew = false) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            nowMillis = System.currentTimeMillis()
        }
    }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_600)
            copied = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = Theme.background,
        dragHandle = { BottomSheetDefaults.DragHandle(color = Theme.textSecondary) },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "Pair your computer",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = Theme.textPrimary,
                )
                IconButton(onClick = { load(forceNew = true) }) {
                    Icon(
                        imageVector = Icons.Rounded.Refresh,
                        contentDescription = "Get a new code",
                        tint = Theme.planning,
                    )
                }
            }

            when (val current = phase) {
                PairPhase.Loading -> MessageBlock(
                    text = "Getting a fresh code…",
                    leading = {
                        CircularProgressIndicator(
                            modifier = Modifier.size(28.dp),
                            color = Theme.textSecondary,
                            strokeWidth = 3.dp,
                        )
                    },
                )

                is PairPhase.Failed -> MessageBlock(
                    text = current.message,
                    leading = {
                        Icon(
                            imageVector = Icons.Rounded.Warning,
                            contentDescription = null,
                            tint = Theme.testing,
                            modifier = Modifier.size(36.dp),
                        )
                    },
                    actionLabel = "Try again",
                    onAction = { load(forceNew = false) },
                )

                is PairPhase.Ready -> {
                    val remaining = ((current.expiresAtMillis - nowMillis) / 1_000L).toInt()
                    if (remaining > 0) {
                        ActiveCode(
                            code = current.code,
                            board = board,
                            remainingSeconds = remaining,
                            copied = copied,
                            onCopy = { command ->
                                copyToClipboard(context, command)
                                copied = true
                            },
                        )
                    } else {
                        MessageBlock(
                            text = "Codes only live for a few minutes. Grab a new one.",
                            title = "Code expired",
                            leading = {
                                Icon(
                                    imageVector = Icons.Rounded.Schedule,
                                    contentDescription = null,
                                    tint = Theme.textSecondary,
                                    modifier = Modifier.size(36.dp),
                                )
                            },
                            actionLabel = "New code",
                            onAction = { load(forceNew = true) },
                        )
                    }
                }
            }
        }
    }
}

// MARK: - Phases

@Composable
private fun ActiveCode(
    code: PairCode,
    board: Board?,
    remainingSeconds: Int,
    copied: Boolean,
    onCopy: (String) -> Unit,
) {
    Text(
        text = groupedCode(code.code),
        fontFamily = FontFamily.Monospace,
        fontSize = 44.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 2.sp,
        color = Theme.textPrimary,
        maxLines = 1,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth(),
    )

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val tint = if (remainingSeconds < 60) Theme.testing else Theme.textSecondary
        Icon(
            imageVector = Icons.Rounded.Schedule,
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(16.dp),
        )
        Text(
            text = "Expires in ${timeString(remainingSeconds)}",
            style = MaterialTheme.typography.bodyMedium,
            color = tint,
        )
    }

    if (board != null) {
        val command = code.command(board)

        SelectionContainer {
            Text(
                text = command,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                color = Theme.textPrimary,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(Theme.card)
                    .border(1.dp, Theme.cardBorder, RoundedCornerShape(12.dp))
                    .padding(14.dp),
            )
        }

        Button(
            onClick = { onCopy(command) },
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = if (copied) Theme.done else Theme.planning,
                contentColor = Theme.textPrimary,
            ),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
        ) {
            Icon(
                imageVector = if (copied) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.size(10.dp))
            Text(
                text = if (copied) "Copied" else "Copy command",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
        }

        Text(
            text = "Run this in your terminal — it wires Claude Code hooks to this board.",
            style = MaterialTheme.typography.bodySmall,
            color = Theme.textSecondary,
            textAlign = TextAlign.Center,
        )

        BoardQrCode(boardUrl = board.boardUrl)
    }
}

/** The board URL as a QR, so another phone can join without any typing. */
@Composable
private fun BoardQrCode(boardUrl: String) {
    val dark = Theme.background.toArgb()
    val light = Theme.textPrimary.toArgb()
    val bitmap = remember(boardUrl, dark, light) {
        qrBitmap(boardUrl, QR_SIZE_PX, dark, light)?.asImageBitmap()
    }
    if (bitmap == null) return

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Image(
            bitmap = bitmap,
            contentDescription = "QR code for this board's URL",
            filterQuality = FilterQuality.None,
            modifier = Modifier
                .size(184.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Theme.textPrimary)
                .padding(8.dp),
        )
        Text(
            text = "Scan this from another phone to open the same board.",
            style = MaterialTheme.typography.bodySmall,
            color = Theme.textSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun MessageBlock(
    text: String,
    leading: @Composable () -> Unit,
    title: String? = null,
    actionLabel: String? = null,
    onAction: () -> Unit = {},
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        leading()
        if (title != null) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = Theme.textPrimary,
            )
        }
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = Theme.textSecondary,
            textAlign = TextAlign.Center,
        )
        if (actionLabel != null) {
            Button(
                onClick = onAction,
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Theme.planning,
                    contentColor = Theme.textPrimary,
                ),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.Refresh,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.size(8.dp))
                Text(
                    text = actionLabel,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

// MARK: - Helpers

private const val QR_SIZE_PX = 512

private suspend fun fetchPairPhase(store: SessionStore, forceNew: Boolean): PairPhase =
    try {
        val code = store.pairCode(forceNew)
        PairPhase.Ready(
            code = code,
            expiresAtMillis = System.currentTimeMillis() + code.expiresInSeconds * 1_000L,
        )
    } catch (error: CancellationException) {
        throw error
    } catch (error: ApiException) {
        PairPhase.Failed(
            if (error.kind == ApiException.Kind.RATE_LIMITED) {
                "A few codes are already out for this board. Wait a minute for one to " +
                    "expire, then try again."
            } else {
                friendlyMessage(error)
            }
        )
    } catch (error: Exception) {
        PairPhase.Failed(friendlyMessage(error))
    }

/** Server codes arrive dash-grouped; older ones didn't, so group those too. */
private fun groupedCode(code: String): String =
    if (code.contains('-') || code.length < 6 || code.length % 2 != 0) {
        code
    } else {
        code.chunked(code.length / 2).joinToString("-")
    }

private fun timeString(seconds: Int): String =
    String.format(Locale.US, "%d:%02d", seconds / 60, seconds % 60)

private fun qrBitmap(content: String, sizePx: Int, dark: Int, light: Int): Bitmap? = runCatching {
    val hints = mapOf(
        EncodeHintType.MARGIN to 1,
        EncodeHintType.CHARACTER_SET to "UTF-8",
    )
    val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, sizePx, sizePx, hints)
    val width = matrix.width
    val height = matrix.height
    val pixels = IntArray(width * height)
    for (y in 0 until height) {
        val row = y * width
        for (x in 0 until width) {
            pixels[row + x] = if (matrix.get(x, y)) dark else light
        }
    }
    Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
}.getOrNull()

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText("AgStatus", text))
}
