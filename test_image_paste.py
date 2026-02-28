"""
测试图片粘贴和上传功能
"""
import asyncio
import aiohttp
import json
import base64
from io import BytesIO

SERVER_URL = "http://127.0.0.1:8000"

async def test_image_upload():
    """测试图片上传 API"""
    print("测试图片上传 API...")

    # 创建一个简单的测试图片 (1x1 红色像素 PNG)
    png_data = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
    )

    # 上传图片
    form_data = aiohttp.FormData()
    form_data.add_field('file', png_data, filename='test.png', content_type='image/png')

    async with aiohttp.ClientSession() as session:
        async with session.post(f"{SERVER_URL}/api/upload/image", data=form_data) as resp:
            if resp.status != 200:
                print(f"❌ 图片上传失败: {resp.status}")
                return False

            result = await resp.json()
            print(f"✅ 图片上传成功: {result}")
            return True

async def test_send_message_with_image():
    """测试发送带图片的消息"""
    print("\n测试发送带图片的消息...")

    # 先创建一个线程
    async with aiohttp.ClientSession() as session:
        # 创建线程
        create_resp = await session.post(f"{SERVER_URL}/api/threads", json={"topic": "测试图片功能"})
        if create_resp.status != 201:
            print(f"❌ 创建线程失败: {create_resp.status}")
            return False

        thread = await create_resp.json()
        thread_id = thread['id']
        print(f"✅ 创建线程: {thread_id}")

        # 上传图片
        png_data = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
        )
        form_data = aiohttp.FormData()
        form_data.add_field('file', png_data, filename='test.png', content_type='image/png')

        upload_resp = await session.post(f"{SERVER_URL}/api/upload/image", data=form_data)
        if upload_resp.status != 200:
            print(f"❌ 图片上传失败: {upload_resp.status}")
            return False

        upload_result = await upload_resp.json()
        image_url = upload_result['url']
        print(f"✅ 图片上传成功: {image_url}")

        # 发送带图片的消息
        message_payload = {
            "author": "test_user",
            "role": "user",
            "content": "这是一条带图片的消息",
            "images": [{"url": image_url, "name": "test.png"}]
        }

        msg_resp = await session.post(
            f"{SERVER_URL}/api/threads/{thread_id}/messages",
            json=message_payload
        )

        if msg_resp.status != 201:
            print(f"❌ 发送消息失败: {msg_resp.status}")
            return False

        message = await msg_resp.json()
        print(f"✅ 消息发送成功: {message['id']}")
        print(f"   消息元数据: {message.get('metadata', {})}")

        # 验证消息中包含图片信息
        if message.get('metadata') and 'images' in message['metadata']:
            print(f"✅ 消息中包含图片信息: {message['metadata']['images']}")
            return True
        else:
            print(f"❌ 消息中缺少图片信息")
            return False

async def main():
    try:
        # 测试图片上传
        upload_ok = await test_image_upload()

        # 测试发送带图片的消息
        message_ok = await test_send_message_with_image()

        if upload_ok and message_ok:
            print("\n✅ 所有测试通过!")
            exit(0)
        else:
            print("\n❌ 部分测试失败")
            exit(1)

    except aiohttp.ClientConnectorError:
        print("❌ 错误: 无法连接到服务器。请确保服务器正在运行 http://127.0.0.1:8000")
        exit(1)
    except Exception as e:
        print(f"❌ 错误: {e}")
        import traceback
        traceback.print_exc()
        exit(1)

if __name__ == "__main__":
    asyncio.run(main())