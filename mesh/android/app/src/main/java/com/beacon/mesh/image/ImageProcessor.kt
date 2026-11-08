package com.beacon.mesh.image

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID

/**
 * Processed case image prepared for upload or offline storage.
 */
data class ProcessedImage(
    val id: String, // UUID
    val file: File,
    val width: Int,
    val height: Int,
    val bytes: Int,
    val caption: String? = null,
)

/**
 * Client-side case image pipeline according to Beacon API specifications:
 * - Downscale client-side (max 1600 px on the long edge).
 * - Bake rotation into pixels (from EXIF orientation).
 * - Strip EXIF/GPS and other metadata (fresh JPEG encoding).
 * - JPEG quality ~75.
 * - Client-generated UUID per image.
 * - Caption <= 200 chars.
 * - Max 6 photos per case.
 */
object ImageProcessor {
    const val MAX_LONG_EDGE = 1600
    const val JPEG_QUALITY = 75
    const val MAX_CAPTION_LENGTH = 200
    const val MAX_PHOTOS_PER_CASE = 6

    fun processStream(
        input: InputStream,
        destinationFile: File,
        caption: String? = null,
        id: String = UUID.randomUUID().toString().lowercase(),
    ): ProcessedImage {
        val rawBytes = input.readBytes()
        val exif = runCatching { ExifInterface(ByteArrayInputStream(rawBytes)) }.getOrNull()
        val orientation = exif?.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            ?: ExifInterface.ORIENTATION_NORMAL

        // Read dimensions first
        val boundsOptions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size, boundsOptions)
        val origWidth = boundsOptions.outWidth
        val origHeight = boundsOptions.outHeight
        require(origWidth > 0 && origHeight > 0) { "Invalid image dimensions" }

        // Sample size calculation to prevent out-of-memory
        val maxDim = maxOf(origWidth, origHeight)
        var sampleSize = 1
        while (maxDim / (sampleSize * 2) >= MAX_LONG_EDGE) {
            sampleSize *= 2
        }

        val decodeOptions = BitmapFactory.Options().apply { inSampleSize = sampleSize }
        val decoded = BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size, decodeOptions)
            ?: throw IllegalArgumentException("Could not decode image")

        // Bake orientation
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(270f); matrix.postScale(-1f, 1f) }
        }

        // Downscale long edge to at most 1600 px
        val currentMax = maxOf(decoded.width, decoded.height)
        if (currentMax > MAX_LONG_EDGE) {
            val scale = MAX_LONG_EDGE.toFloat() / currentMax
            matrix.postScale(scale, scale)
        }

        val finalBitmap = if (!matrix.isIdentity) {
            val transformed = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
            if (transformed !== decoded) decoded.recycle()
            transformed
        } else {
            decoded
        }

        destinationFile.parentFile?.mkdirs()
        val baos = ByteArrayOutputStream()
        // Compressing to JPEG encodes raw pixel data into standard JFIF/JPEG frames,
        // which strips any EXIF/GPS tags from the original stream.
        finalBitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, baos)
        val compressedBytes = baos.toByteArray()
        FileOutputStream(destinationFile).use { it.write(compressedBytes) }

        val resultWidth = finalBitmap.width
        val resultHeight = finalBitmap.height
        finalBitmap.recycle()

        val sanitizedCaption = caption?.trim()?.take(MAX_CAPTION_LENGTH)?.ifBlank { null }
        return ProcessedImage(
            id = id,
            file = destinationFile,
            width = resultWidth,
            height = resultHeight,
            bytes = compressedBytes.size,
            caption = sanitizedCaption,
        )
    }

    fun processUri(
        context: Context,
        uri: Uri,
        destinationFile: File,
        caption: String? = null,
        id: String = UUID.randomUUID().toString().lowercase(),
    ): ProcessedImage {
        val stream = context.contentResolver.openInputStream(uri)
            ?: throw IllegalArgumentException("Cannot open URI: $uri")
        return stream.use { processStream(it, destinationFile, caption, id) }
    }
}
