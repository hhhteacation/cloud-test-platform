import { AppleOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Space, Table, Tag, Typography, message } from "antd";
import type { TableProps } from "antd";
import { useCallback, useEffect, useState } from "react";

import { isRealPlatform, platformClient } from "../platform/client";
import type { DeviceConnectionStatus, DeviceDiscoveryCandidate, DeviceProfile } from "../types";
import { formatDate } from "../utils/format";

const connectionLabel: Record<DeviceConnectionStatus, string> = {
  online: "在线",
  offline: "离线",
  unauthorized: "未授权",
  unknown: "未知",
};

const connectionColor: Record<DeviceConnectionStatus, string> = {
  online: "success",
  offline: "error",
  unauthorized: "warning",
  unknown: "default",
};

/**
 * M1 iOS 设备接入：发现 + 注册。执行链路（装 IPA/自动化/报告）在 M2/M3 接入，
 * 因此这里刻意只读展示，不提供任务相关操作。
 */
export function IosDevicesSection() {
  const [devices, setDevices] = useState<DeviceProfile[]>([]);
  const [candidates, setCandidates] = useState<DeviceDiscoveryCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [registeringSerial, setRegisteringSerial] = useState<string>();
  const [error, setError] = useState<string>();

  const loadDevices = useCallback(async () => {
    setRefreshing(true);
    try {
      setDevices(await platformClient.listDevices("ios"));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isRealPlatform) void loadDevices();
    else setLoading(false);
  }, [loadDevices]);

  const scanDevices = useCallback(async () => {
    setScanning(true);
    try {
      const found = await platformClient.discoverDevices("ios");
      setCandidates(found);
      if (found.length === 0) message.info("未发现 USB 连接的 iPhone；请插线并在手机上信任此电脑");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "iOS 设备扫描失败");
    } finally {
      setScanning(false);
    }
  }, []);

  const registerDevice = useCallback(async (serial: string) => {
    setRegisteringSerial(serial);
    try {
      await platformClient.registerDevice(serial, "ios");
      message.success("iPhone 已录入");
      setCandidates((current) => current.filter((candidate) => candidate.serial !== serial));
      await loadDevices();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "iPhone 录入失败");
    } finally {
      setRegisteringSerial(undefined);
    }
  }, [loadDevices]);

  const deviceColumns: TableProps<DeviceProfile>["columns"] = [
    { title: "设备名", dataIndex: "name" },
    { title: "型号", dataIndex: "model" },
    { title: "系统", dataIndex: "osVersion" },
    {
      title: "UDID",
      dataIndex: "serial",
      render: (serial: string) => <Typography.Text code copyable>{serial}</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "overallConnectionStatus",
      render: (status: DeviceConnectionStatus = "unknown") => (
        <Tag color={connectionColor[status]}>{connectionLabel[status]}</Tag>
      ),
    },
    {
      title: "录入时间",
      dataIndex: "registeredAt",
      render: (value?: string) => (value ? formatDate(value) : "—"),
    },
  ];

  const candidateColumns: TableProps<DeviceDiscoveryCandidate>["columns"] = [
    { title: "设备名", dataIndex: "name" },
    { title: "型号", dataIndex: "model" },
    { title: "iOS 版本", dataIndex: "iosVersion" },
    {
      title: "UDID",
      dataIndex: "serial",
      render: (serial: string) => <Typography.Text code copyable>{serial}</Typography.Text>,
    },
    {
      title: "操作",
      render: (_, candidate) =>
        candidate.registeredDeviceId ? (
          <Tag>已录入</Tag>
        ) : (
          <Button
            size="small"
            type="primary"
            loading={registeringSerial === candidate.serial}
            onClick={() => void registerDevice(candidate.serial)}
          >
            录入
          </Button>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={16} className="device-tab-content">
      <Alert
        showIcon
        type="info"
        message="iPhone 通过数据线接入宿主 Mac（M1：发现与录入）"
        description="首次连接需在手机上点「信任此电脑」并开启开发者模式；测试执行（安装 IPA、自动化、报告）将在后续版本开放。"
      />
      {error ? (
        <Alert
          showIcon
          type="error"
          message="iOS 设备列表加载失败"
          description={error}
        />
      ) : null}
      <Card
        className="page-card"
        title={(
          <Space>
            <AppleOutlined />
            已录入 iPhone
          </Space>
        )}
        bordered={false}
        extra={(
          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={refreshing}
              onClick={() => void loadDevices()}
              disabled={!isRealPlatform}
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={scanning}
              onClick={() => void scanDevices()}
              disabled={!isRealPlatform}
            >
              扫描 USB iPhone
            </Button>
          </Space>
        )}
      >
        <Table
          rowKey="id"
          loading={loading}
          columns={deviceColumns}
          dataSource={devices}
          pagination={devices.length > 8 ? { pageSize: 8 } : false}
        />
      </Card>
      {candidates.length > 0 ? (
        <Card title="扫描结果" bordered={false}>
          <Table
            rowKey="serial"
            loading={scanning}
            columns={candidateColumns}
            dataSource={candidates}
            pagination={false}
          />
        </Card>
      ) : null}
    </Space>
  );
}
