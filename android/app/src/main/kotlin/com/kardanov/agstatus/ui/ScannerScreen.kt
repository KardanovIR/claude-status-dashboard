package com.kardanov.agstatus.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CameraAlt
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import com.google.zxing.ResultPoint
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.kardanov.agstatus.Theme

/** A code that stays in frame may need a second attempt; this is the gap. */
private const val RESCAN_COOLDOWN_MS = 3_000L

private enum class CameraPermission { PENDING, GRANTED, DENIED }

/**
 * Full-screen QR scanner for the setup code printed by the pairing command.
 * Falls back to a paste field whenever the camera is unavailable, so a denied
 * permission is never a dead end.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScannerScreen(onResult: (String) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    val hasCamera = remember(context) {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }
    var permission by remember {
        mutableStateOf(
            if (isCameraGranted(context)) CameraPermission.GRANTED else CameraPermission.PENDING
        )
    }
    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        permission = if (granted) CameraPermission.GRANTED else CameraPermission.DENIED
    }

    LaunchedEffect(hasCamera) {
        if (hasCamera && permission == CameraPermission.PENDING) {
            launcher.launch(Manifest.permission.CAMERA)
        }
    }

    // Coming back from the system settings screen is the other way permission
    // can turn into a yes, and it arrives without any result callback.
    val lifecycle = rememberActivityLifecycle()
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && isCameraGranted(context)) {
                permission = CameraPermission.GRANTED
            }
        }
        lifecycle?.addObserver(observer)
        onDispose { lifecycle?.removeObserver(observer) }
    }

    Scaffold(
        containerColor = Theme.background,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "Scan setup QR",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.Rounded.Close, contentDescription = "Close scanner")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Theme.background,
                    titleContentColor = Theme.textPrimary,
                    navigationIconContentColor = Theme.textPrimary,
                ),
            )
        },
    ) { insets ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .background(Theme.background),
        ) {
            when {
                !hasCamera -> ManualFallback(
                    title = "Camera scanning isn't available",
                    message = "This device has no camera we can use. Paste the board URL " +
                        "instead — it's printed right under the QR code.",
                    canOpenSettings = false,
                    onResult = onResult,
                )

                permission == CameraPermission.GRANTED -> {
                    CameraScanner(onDecoded = onResult, modifier = Modifier.fillMaxSize())
                    ScanHint()
                }

                permission == CameraPermission.DENIED -> ManualFallback(
                    title = "Camera access is off",
                    message = "AgStatus only uses the camera to read the setup QR code, and " +
                        "nothing leaves your phone. Turn it on in system settings, or paste " +
                        "the board URL printed under the QR code.",
                    canOpenSettings = true,
                    onResult = onResult,
                )

                else -> CircularProgressIndicator(
                    modifier = Modifier.align(Alignment.Center),
                    color = Theme.textSecondary,
                )
            }
        }
    }
}

// MARK: - Live scanner

@Composable
private fun CameraScanner(onDecoded: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val currentOnDecoded by rememberUpdatedState(onDecoded)
    val scannerView = remember(context) {
        DecoratedBarcodeView(context).apply { setStatusText("") }
    }
    val lifecycle = rememberActivityLifecycle()

    DisposableEffect(scannerView, lifecycle) {
        var lastPayload: String? = null
        var lastPayloadAt = 0L
        scannerView.decodeContinuous(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult) {
                val payload = result.text?.trim().orEmpty()
                if (payload.isEmpty()) return
                val now = SystemClock.elapsedRealtime()
                if (payload == lastPayload && now - lastPayloadAt < RESCAN_COOLDOWN_MS) return
                lastPayload = payload
                lastPayloadAt = now
                currentOnDecoded(payload)
            }

            override fun possibleResultPoints(resultPoints: List<ResultPoint>) = Unit
        })

        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> scannerView.resume()
                Lifecycle.Event.ON_PAUSE -> scannerView.pause()
                else -> Unit
            }
        }
        if (lifecycle == null) scannerView.resume() else lifecycle.addObserver(observer)

        onDispose {
            lifecycle?.removeObserver(observer)
            scannerView.pause()
        }
    }

    AndroidView(factory = { scannerView }, modifier = modifier)
}

@Composable
private fun BoxScope.ScanHint() {
    Box(
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .fillMaxWidth()
            .height(180.dp)
            .background(
                Brush.verticalGradient(
                    listOf(Theme.background.copy(alpha = 0f), Theme.background.copy(alpha = 0.85f))
                )
            ),
    )
    Text(
        text = "Point your camera at the setup QR code shown on your computer.",
        style = MaterialTheme.typography.bodyMedium,
        color = Theme.textPrimary,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .padding(horizontal = 24.dp, vertical = 28.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Theme.background.copy(alpha = 0.7f))
            .padding(horizontal = 16.dp, vertical = 12.dp),
    )
}

// MARK: - Fallback

@Composable
private fun ManualFallback(
    title: String,
    message: String,
    canOpenSettings: Boolean,
    onResult: (String) -> Unit,
) {
    val context = LocalContext.current
    var text by rememberSaveable { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(horizontal = 20.dp)
            .padding(top = 32.dp, bottom = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(
            imageVector = Icons.Rounded.CameraAlt,
            contentDescription = null,
            tint = Theme.textSecondary,
            modifier = Modifier.size(40.dp),
        )
        Text(
            text = title,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
            color = Theme.textPrimary,
            textAlign = TextAlign.Center,
        )
        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            color = Theme.textSecondary,
            textAlign = TextAlign.Center,
        )

        if (canOpenSettings) {
            TextButton(onClick = { openAppSettings(context) }) {
                Text(
                    text = "Open system settings",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Medium,
                    color = Theme.planning,
                )
            }
        }

        UrlInputField(
            value = text,
            onValueChange = { text = it },
            placeholder = "https://…/w/ags_…",
            onSubmit = { text.trim().takeIf { it.isNotEmpty() }?.let(onResult) },
        )

        Button(
            onClick = { text.trim().takeIf { it.isNotEmpty() }?.let(onResult) },
            enabled = text.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = Theme.planning,
                contentColor = Theme.textPrimary,
                disabledContainerColor = Theme.planning.copy(alpha = 0.5f),
                disabledContentColor = Theme.textPrimary.copy(alpha = 0.7f),
            ),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
        ) {
            Text(
                text = "Use this URL",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Spacer(Modifier.size(8.dp))
    }
}

// MARK: - Helpers

@Composable
private fun rememberActivityLifecycle(): Lifecycle? {
    val context = LocalContext.current
    return remember(context) { (context.findActivity() as? LifecycleOwner)?.lifecycle }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

private fun isCameraGranted(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED

private fun openAppSettings(context: Context) {
    val intent = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.fromParts("package", context.packageName, null),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}
