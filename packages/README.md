# Shared Packages

- `contracts`: 可安全暴露给浏览器的 DTO、共享类型和错误码。
- `domain`: 与框架无关的业务规则和状态机。
- `database`: migration、事务及数据访问；用户资源查询必须限定所有者。
- `providers`: 图像、对象存储和邮件服务适配器。
- `config`: 服务端环境变量读取与校验。

数据库实体和供应商原始响应不得放入 `contracts`。

