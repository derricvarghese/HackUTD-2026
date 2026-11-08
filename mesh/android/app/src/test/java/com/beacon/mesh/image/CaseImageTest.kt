package com.beacon.mesh.image

import android.content.Context
import android.graphics.Bitmap
import androidx.test.core.app.ApplicationProvider
import com.beacon.mesh.MeshRouter
import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.net.ApiResult
import com.beacon.mesh.net.BeaconApi
import com.beacon.mesh.net.RequestSigner
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.responder.CaseImage
import com.beacon.mesh.store.InMemoryMessageStore
import com.beacon.mesh.store.MessageStore
import com.beacon.mesh.store.PendingImage
import com.beacon.mesh.store.SqliteMessageStore
import com.beacon.mesh.support.FakeBackendKeys
import com.beacon.mesh.support.FakeHttp
import com.beacon.mesh.ui.logic.SosDraft
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CaseImageTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Test
    fun imageProcessorDownscalesLargeImageAndStripsExif() {
        val origBitmap = Bitmap.createBitmap(2400, 1200, Bitmap.Config.ARGB_8888)
        val stream = ByteArrayOutputStream()
        origBitmap.compress(Bitmap.CompressFormat.JPEG, 90, stream)
        val origBytes = stream.toByteArray()

        val destFile = File(context.cacheDir, "test_downscale_${System.currentTimeMillis()}.jpg")
        val processed = ImageProcessor.processStream(
            input = ByteArrayInputStream(origBytes),
            destinationFile = destFile,
            caption = "Test caption",
        )

        assertEquals(1600, processed.width)
        assertEquals(800, processed.height)
        assertEquals("Test caption", processed.caption)
        assertTrue(destFile.exists())
        assertEquals(destFile.length().toInt(), processed.bytes)

        // Verify fresh JPEG header
        val header = destFile.readBytes().take(2).toByteArray()
        assertEquals(0xFF.toByte(), header[0])
        assertEquals(0xD8.toByte(), header[1])
        destFile.delete()
    }

    @Test
    fun imageProcessorDoesNotUpscaleSmallerImages() {
        val origBitmap = Bitmap.createBitmap(800, 600, Bitmap.Config.ARGB_8888)
        val stream = ByteArrayOutputStream()
        origBitmap.compress(Bitmap.CompressFormat.JPEG, 90, stream)
        val origBytes = stream.toByteArray()

        val destFile = File(context.cacheDir, "test_small_${System.currentTimeMillis()}.jpg")
        val processed = ImageProcessor.processStream(
            input = ByteArrayInputStream(origBytes),
            destinationFile = destFile,
        )

        assertEquals(800, processed.width)
        assertEquals(600, processed.height)
        assertNull(processed.caption)
        destFile.delete()
    }

    @Test
    fun imageProcessorClampsCaptionTo200Chars() {
        val origBitmap = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)
        val stream = ByteArrayOutputStream()
        origBitmap.compress(Bitmap.CompressFormat.JPEG, 80, stream)
        val origBytes = stream.toByteArray()

        val longCaption = "A".repeat(250)
        val destFile = File(context.cacheDir, "test_cap_${System.currentTimeMillis()}.jpg")
        val processed = ImageProcessor.processStream(
            input = ByteArrayInputStream(origBytes),
            destinationFile = destFile,
            caption = longCaption,
        )

        assertEquals(200, processed.caption?.length)
        assertEquals("A".repeat(200), processed.caption)

        val blankProcessed = ImageProcessor.processStream(
            input = ByteArrayInputStream(origBytes),
            destinationFile = destFile,
            caption = "   ",
        )
        assertNull(blankProcessed.caption)
        destFile.delete()
    }

    @Test
    fun sosDraftEnforcesMax6Images() {
        var draft = SosDraft(Category.TRAPPED)
        assertEquals(0, draft.images.size)

        val dummyFile = File(context.cacheDir, "dummy.jpg")
        for (i in 1..6) {
            val img = ProcessedImage(
                id = "id-$i",
                file = dummyFile,
                width = 800,
                height = 600,
                bytes = 1000,
                caption = "Photo $i",
            )
            draft = draft.withImage(img)
        }
        assertEquals(6, draft.images.size)

        // 7th image must be rejected
        val extraImg = ProcessedImage(
            id = "id-7",
            file = dummyFile,
            width = 800,
            height = 600,
            bytes = 1000,
            caption = "Photo 7",
        )
        val rejectedDraft = draft.withImage(extraImg)
        assertEquals(6, rejectedDraft.images.size)

        // Remove an image
        val removedDraft = draft.withoutImage("id-3")
        assertEquals(5, removedDraft.images.size)
        assertFalse(removedDraft.images.any { it.id == "id-3" })

        // Update caption
        val updatedDraft = draft.withImageCaption("id-2", "Updated caption")
        assertEquals("Updated caption", updatedDraft.images.first { it.id == "id-2" }.caption)
    }

    @Test
    fun pendingImagesStoreLifecycleInMemory() {
        val store: MessageStore = InMemoryMessageStore()
        verifyStorePendingImages(store)
    }

    @Test
    fun pendingImagesStoreLifecycleSqlite() {
        val store: MessageStore = SqliteMessageStore(context)
        verifyStorePendingImages(store)
    }

    private fun verifyStorePendingImages(store: MessageStore) {
        val img1 = PendingImage(
            id = UUID.randomUUID().toString(),
            sosId = "sos-001",
            filePath = "/path/to/img1.jpg",
            caption = "First photo",
            createdAtMs = 1000L,
        )
        val img2 = PendingImage(
            id = UUID.randomUUID().toString(),
            sosId = "sos-001",
            filePath = "/path/to/img2.jpg",
            caption = "Second photo",
            createdAtMs = 2000L,
        )
        val img3 = PendingImage(
            id = UUID.randomUUID().toString(),
            sosId = "sos-002",
            filePath = "/path/to/img3.jpg",
            caption = "Other case photo",
            createdAtMs = 3000L,
        )

        store.savePendingImage(img1)
        store.savePendingImage(img2)
        store.savePendingImage(img3)

        val allPending = store.pendingImages()
        assertEquals(3, allPending.size)

        val sos1Pending = store.pendingImages("sos-001")
        assertEquals(2, sos1Pending.size)
        assertEquals(listOf(img1.id, img2.id), sos1Pending.map { it.id })

        store.markImageUploaded(img1.id)
        val updated = store.pendingImages("sos-001").first { it.id == img1.id }
        assertTrue(updated.uploaded)

        store.deletePendingImage(img2.id)
        val remaining = store.pendingImages("sos-001")
        assertEquals(1, remaining.size)
        assertEquals(img1.id, remaining[0].id)
    }

    @Test
    fun beaconApiUploadCaseImageAndListImages() {
        val keys = FakeBackendKeys()
        val signer = SoftwareSigner()
        val http = FakeHttp()
        val cfg: BackendConfig = keys.config()
        val deviceId = "0192a000-0000-7000-8000-0000000000d1"
        val api = BeaconApi(
            baseUrl = "https://example.test",
            http = http,
            signer = RequestSigner(signer) { 1_794_000_000_000L },
            config = cfg,
            publicKeyB64 = Base64.getEncoder().encodeToString(signer.publicKeyDer),
            appVersion = "0.3",
        )

        http.on("POST", "/v1/devices") {
            http.json(201, """{"id":"$deviceId","sender_hash":"abc","created_at":"2026-11-07T00:00:00Z"}""")
        }

        val testSosId = "sos-uuid-1"
        val testImageId = "img-uuid-2"
        val imagePayload = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xAA.toByte())

        http.on("PUT", "/v1/sos/$testSosId/images/$testImageId") { req ->
            assertEquals("image/jpeg", req.headers["Content-Type"])
            assertEquals(deviceId, req.headers["X-Device-Id"])
            assertNotNull(req.headers["X-Device-Signature"])
            http.json(201, """{
                "id": "$testImageId",
                "content_type": "image/jpeg",
                "bytes": ${imagePayload.size},
                "width": 1600,
                "height": 1200,
                "caption": "test caption",
                "uploaded_by": { "kind": "device" },
                "created_at": "2026-11-08T09:00:00Z"
            }""")
        }

        val uploadResult = api.uploadCaseImage(testSosId, testImageId, imagePayload, "test caption")
        assertTrue(uploadResult is ApiResult.Ok)
        val uploadedImage = (uploadResult as ApiResult.Ok).value
        assertEquals(testImageId, uploadedImage.id)
        assertEquals(1600, uploadedImage.width)
        assertEquals("test caption", uploadedImage.caption)

        // Test listCaseImages
        http.on("GET", "/v1/sos/$testSosId/images") {
            http.json(200, """{
                "data": [
                    {
                        "id": "$testImageId",
                        "content_type": "image/jpeg",
                        "bytes": ${imagePayload.size},
                        "width": 1600,
                        "height": 1200,
                        "caption": "test caption",
                        "uploaded_by": { "kind": "device" },
                        "created_at": "2026-11-08T09:00:00Z"
                    }
                ]
            }""")
        }

        val listResult = api.listCaseImages(testSosId)
        assertTrue(listResult is ApiResult.Ok)
        val imagesList = (listResult as ApiResult.Ok).value
        assertEquals(1, imagesList.size)
        assertEquals(testImageId, imagesList[0].id)
    }

    @Test
    fun meshRouterIncludesImageCountHintWhenImagesPresent() {
        val keys = FakeBackendKeys()
        val signer = SoftwareSigner()
        val store = InMemoryMessageStore()
        val cfg = keys.config()
        val router = MeshRouter(signer, store, cfg) { 1_794_000_000_000L }

        // Originate with images
        router.originate(
            category = Category.TRAPPED,
            text = "Need help trapped under debris",
            lat = 32.9857,
            lng = -96.7501,
            imageCount = 3,
        )

        val messagesWithImages = store.all()
        assertEquals(1, messagesWithImages.size)
        val ownPayloadWithImages = JSONObject(messagesWithImages[0].ownPayload!!)
        assertEquals(3, ownPayloadWithImages.getInt("image_count"))
        assertTrue(ownPayloadWithImages.getBoolean("has_images"))

        // Originate without images
        val store2 = InMemoryMessageStore()
        val router2 = MeshRouter(signer, store2, cfg) { 1_794_000_000_000L }
        router2.originate(
            category = Category.INJURED,
            text = "Need first aid",
            lat = 32.9857,
            lng = -96.7501,
            imageCount = 0,
        )

        val messagesWithoutImages = store2.all()
        assertEquals(1, messagesWithoutImages.size)
        val ownPayloadWithoutImages = JSONObject(messagesWithoutImages[0].ownPayload!!)
        assertFalse(ownPayloadWithoutImages.optBoolean("has_images", false))
        assertEquals(0, ownPayloadWithoutImages.optInt("image_count", 0))
    }
}
