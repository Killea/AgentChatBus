"""
调试 agent 在线状态问题
"""
import asyncio
import aiohttp
import json

SERVER_URL = "http://127.0.0.1:8000"

async def debug_agent_status():
    """检查 agent API 返回的数据"""
    print("=== 调试 Agent 在线状态 ===\n")

    async with aiohttp.ClientSession() as session:
        # 获取所有 agent
        async with session.get(f"{SERVER_URL}/api/agents") as resp:
            if resp.status != 200:
                print(f"❌ 获取 agent 列表失败: {resp.status}")
                return

            agents = await resp.json()
            print(f"找到 {len(agents)} 个 agent:\n")

            for i, agent in enumerate(agents, 1):
                print(f"Agent {i}:")
                print(f"  ID: {agent.get('id')}")
                print(f"  Name: {agent.get('name')}")
                print(f"  Display Name: {agent.get('display_name')}")
                print(f"  is_online: {agent.get('is_online')}")
                print(f"  last_heartbeat: {agent.get('last_heartbeat')}")
                print(f"  last_activity: {agent.get('last_activity')}")
                print(f"  last_activity_time: {agent.get('last_activity_time')}")

                # 计算状态
                activity_time = agent.get('last_activity_time')
                if activity_time:
                    from datetime import datetime
                    activity_dt = datetime.fromisoformat(activity_time.replace('Z', '+00:00'))
                    now = datetime.now()
                    seconds_ago = (now - activity_dt).total_seconds()
                    print(f"  距离上次活动: {seconds_ago:.0f} 秒")

                    # 模拟 getAgentState 逻辑
                    if agent.get('last_activity') == 'msg_wait' and seconds_ago < 60:
                        state = 'Waiting'
                    elif seconds_ago < 30:
                        state = 'Active'
                    elif seconds_ago < 300:
                        state = 'Idle'
                    else:
                        state = 'Offline' if not agent.get('is_online') else 'Idle'
                else:
                    state = 'Waiting' if agent.get('is_online') else 'Offline'

                print(f"  计算状态: {state}")
                print()

            # 检查过滤逻辑
            print("=== 过滤逻辑测试 ===\n")
            offline_agents = [a for a in agents if agent.get('last_activity_time') is None or not agent.get('is_online')]
            print(f"可能被过滤为 Offline 的 agent 数量: {len(offline_agents)}")

            if offline_agents:
                print("\n这些 agent 可能被过滤:")
                for agent in offline_agents:
                    print(f"  - {agent.get('display_name') or agent.get('name')} (is_online={agent.get('is_online')}, last_activity_time={agent.get('last_activity_time')})")

async def main():
    try:
        await debug_agent_status()
    except aiohttp.ClientConnectorError:
        print("❌ 错误: 无法连接到服务器。请确保服务器正在运行 http://127.0.0.1:8000")
    except Exception as e:
        print(f"❌ 错误: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
