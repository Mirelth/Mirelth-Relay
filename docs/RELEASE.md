# 通过 CNB 发行版发布新版本

仓库与发行版入口：<https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases>。
手动在网页上传可行（发行版页 → 编辑 → 拖附件），但文件 >100MB 走浏览器容易断，推荐以下 API 流程（已验证）。

## 前置

- 本机 git 凭据在 macOS 钥匙串（`security find-internet-password -s cnb.cool -w` 可取 token；账号名固定为 `cnb`）。
- API 请求**必须带** `Accept: application/json` 头，否则一律返回 errcode 406。
- 完整接口定义：<https://api.cnb.cool/swagger.json>。

## 发布步骤

```bash
TOKEN=$(security find-internet-password -s cnb.cool -w)
RID=<release_id>   # 见下
API=https://api.cnb.cool/WeiGuangXunTu/AgentTower
```

1. **打 tag 并发 Release**：
   ```bash
   curl -u "cnb:$TOKEN" -H "Content-Type: application/json" -H "Accept: application/json" \
     -d '{"tag_name":"v1.0.1","name":"AgentTower v1.0.1","target_commitish":"main",
          "body":"…markdown 描述…","draft":false,"prerelease":false,"make_latest":"true"}' \
     $API/-/releases
   ```
   响应里的 `id` 即 `RID`。
2. **每个安装包**（dmg×2 / exe）三步：
   ```bash
   SZ=$(stat -f%z <文件>)
   # a) 申请上传地址（同名覆盖用 overwrite:true；ttl:0 = 永久保留）
   curl -u "cnb:$TOKEN" -H "Content-Type: application/json" -H "Accept: application/json" \
     -d "{\"asset_name\":\"<文件名>\",\"size\":$SZ,\"ttl\":0,\"overwrite\":true}" \
     $API/-/releases/$RID/asset-upload-url
   # b) 上传文件到响应里的 upload_url
   curl -T <文件> <upload_url>
   # c) 确认：POST 响应里的 verify_url
   curl -u "cnb:$TOKEN" -H "Accept: application/json" -X POST <verify_url>
   ```
3. **验证**：`GET $API/-/releases/tags/<tag>` 比对资产名与字节数；公开直链格式
   `https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases/download/<tag>/<文件名>`（匿名 302 到 CDN，可直接发给别人）。
4. 更新 README「下载」区（链接文件名含版本号，每次发版都要改）。
